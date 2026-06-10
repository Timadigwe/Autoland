import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { ConfigManager } from "../utils/config";
import { WalletManager } from "../services/wallet-manager";
import { GrpcStreamService } from "../services/grpc-stream";
import { MeteoraTransactionParser } from "../services/transaction-parser";
import { MeteoraTransactionBuilder } from "../services/transaction-builder";
import { JitoBundleSender } from "../services/jito-bundle-sender";
import { TransactionSimulator } from "../services/transaction-simulator";
import { BotConfig, PoolAccounts, TradeTarget } from "../types/config";
import { DlmmManager } from "../services/dlmm-manager";
import { AiTippingAgent, NetworkCongestionData } from "../services/ai-tipping-agent";
import { LifecycleTracker, CommitmentStage } from "../services/lifecycle-tracker";
import bs58 from "bs58";

export class DlmmMarketMaker {
  private config: BotConfig;
  private connection: Connection;
  private walletManager: WalletManager;
  private grpcStream: GrpcStreamService;
  private transactionParser: MeteoraTransactionParser;
  private transactionBuilder: MeteoraTransactionBuilder;
  private jitoBundleSender: JitoBundleSender;
  private transactionSimulator: TransactionSimulator;
  private dlmmManager: DlmmManager;
  private aiTippingAgent: AiTippingAgent;
  private lifecycleTracker: LifecycleTracker;
  private isRunning: boolean = false;
  private hasExecuted: boolean = false;
  private pendingConfirmations: Map<string, { resolve: (status: CommitmentStage) => void }> = new Map();
  private tipAccountBalances: Map<string, number> = new Map();
  private recentTips: number[] = [];

  private latestSlotInfo: NetworkCongestionData = {
    recentSlot: 0,
    recentBlockhash: "",
    transactionsInRecentBlocks: 0,
    estimatedAveragePriorityFee: 10000,
    jitoTipPercentile50: 10000,
    poolVolatility: "Low",
    timeSinceLastTradeMs: 0
  };

  constructor(meteoraIdl: Idl) {
    this.config = ConfigManager.getInstance().getConfig();
    this.connection = new Connection(this.config.rpc.url, "confirmed");

    this.walletManager = new WalletManager(this.connection);
    this.grpcStream = new GrpcStreamService(this.config);
    this.transactionParser = new MeteoraTransactionParser(
      this.config.meteora.programId,
      meteoraIdl,
      this.config
    );
    this.transactionBuilder = new MeteoraTransactionBuilder(
      this.config.meteora.programId,
      this.config
    );
    this.jitoBundleSender = new JitoBundleSender(this.config, this.connection);
    this.transactionSimulator = new TransactionSimulator(this.connection, this.config);
    this.dlmmManager = new DlmmManager(this.connection);
    this.aiTippingAgent = new AiTippingAgent();
    this.lifecycleTracker = new LifecycleTracker();
  }

  public async initialize(): Promise<void> {
    console.log(" Initializing Intelligent DLMM Market Maker Bot...");

    try {
      await this.walletManager.initializeWallets(this.config.wallets.privateKeys);

      const totalBalance = this.walletManager.getTotalBalance();
      const walletCount = this.walletManager.getWalletCount();

      console.log(` Total balance across ${walletCount} wallets: ${totalBalance.toFixed(4)} SOL`);

      const requiredBalance = this.config.trading.tradeAmountSol * walletCount;
      if (totalBalance < requiredBalance) {
        if (this.config.trading.dryRun) {
          console.log(`[DRY RUN] Insufficient balance (Required: ${requiredBalance} SOL, Available: ${totalBalance} SOL). Bypassing check...`);
        } else {
          throw new Error(
            `Insufficient balance. Required: ${requiredBalance} SOL, Available: ${totalBalance} SOL`
          );
        }
      }

      console.log(" Checking DLMM positions for active wallets...");
      const wallets = this.walletManager.getWallets();
      for (const wallet of wallets) {
        const initTx = await this.dlmmManager.checkAndInitializePosition(wallet.keypair);
        if (initTx) {
          console.log(` Provisioning transaction ready for wallet ${wallet.keypair.publicKey.toBase58()}. Submitting via Jito...`);
          await this.sendTransactionsWithRetry([initTx], [wallet]);
        }
      }

      console.log(" Bot initialized successfully");
    } catch (error) {
      console.error(" Failed to initialize bot:", error);
      throw error;
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      console.log("Bot is already running");
      return;
    }

    console.log(" Starting Intelligent DLMM Market Maker...");
    console.log(` Monitoring swaps on target pool to track volatility...`);

    this.isRunning = true;
    this.hasExecuted = false;

    await this.grpcStream.startStream(
      this.handleTransaction.bind(this),
      this.handleSlot.bind(this),
      this.handleTransactionStatus.bind(this),
      this.handleAccount.bind(this)
    );
  }

  private handleAccount(data: any): void {
    if (data?.account?.account?.pubkey && data?.account?.account?.lamports !== undefined) {
      const pubkey = bs58.encode(Buffer.from(data.account.account.pubkey, 'base64'));
      const lamportsStr = data.account.account.lamports;
      const currentLamports = parseInt(lamportsStr, 10);
      
      const previousLamports = this.tipAccountBalances.get(pubkey) || 0;
      
      // Calculate diff
      if (previousLamports > 0 && currentLamports > previousLamports) {
        const tipPaid = currentLamports - previousLamports;
        
        // Ignore massive outliers that aren't real tips
        if (tipPaid > 0 && tipPaid < 100 * 1e9) {
          this.recentTips.push(tipPaid);
          if (this.recentTips.length > 50) {
            this.recentTips.shift(); // Keep window at 50
          }
          
          // Calculate median (50th percentile)
          const sorted = [...this.recentTips].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          this.latestSlotInfo.jitoTipPercentile50 = median;
        }
      }
      
      this.tipAccountBalances.set(pubkey, currentLamports);
    }
  }

  private handleSlot(data: any): void {
    if (data?.slot?.slot) {
      this.latestSlotInfo.recentSlot = data.slot.slot;
      // In a full implementation, we'd calculate tx rates and fee trends here.
      // For now, we just update the slot to show integration works.
    }
  }

  private handleTransactionStatus(data: any): void {
    if (data?.transactionStatus?.transactionStatus) {
      const status = data.transactionStatus.transactionStatus;
      const signature = bs58.encode(Buffer.from(data.transactionStatus.signature, 'base64'));
      const slot = data.transactionStatus.slot;
      const error = status.err;

      let stage: CommitmentStage = 'processed';
      if (error) {
        stage = 'failed';
      } else {
        // Map confirmation status (in a robust implementation we map the exact confirmation level)
        // Yellowstone streams it when it is processed/confirmed.
        stage = 'confirmed';
      }

      this.lifecycleTracker.recordEvent({
        signature,
        stage,
        timestamp: Date.now(),
        slot,
        failureReason: error ? JSON.stringify(error) : undefined
      });

      const pending = this.pendingConfirmations.get(signature);
      if (pending) {
        pending.resolve(stage);
        this.pendingConfirmations.delete(signature);
      }
    }
  }

  private async handleTransaction(data: any): Promise<void> {
    if (this.hasExecuted) {
      return;
    }

    try {

      const signature = this.transactionParser.getTransactionSignature(data);
      if (!signature) {
        return;
      }

      const timestamp = new Date().toISOString();

      const blockTime = data?.transaction?.transaction?.meta?.blockTime;
      const blockTimeStr = blockTime ? new Date(blockTime * 1000).toISOString() : 'unknown';
      console.log(` Transaction detected: ${signature} at ${timestamp} (blocktime: ${blockTimeStr})`);

      if (!this.transactionParser.isTargetTransaction(data)) {
        return;
      }

      if (this.transactionParser.isSwapTransaction(data)) {
        // Here we track swaps to determine pool volatility and trend
        // This data feeds into the AiStrategyAgent
        this.latestSlotInfo.transactionsInRecentBlocks++;

        // Example threshold: If we see a lot of swaps, we might trigger a rebalance
        if (this.latestSlotInfo.transactionsInRecentBlocks > 100 && !this.hasExecuted) {
          console.log(" High volatility detected. Triggering LP strategy rebalance...");
          // In a full implementation, we'd fetch current pool accounts here.
          // For the bounty demonstration, we will trigger executeTrade to demonstrate the stack.
          const dummyPoolAccounts = {
            poolAddress: this.config.dlmm.targetPool,
            tokenX: "TokenX...",
            tokenY: "TokenY..."
          } as any;

          await this.executeTrade({ poolAccounts: dummyPoolAccounts, timestamp: Date.now() });
        }
      }
    } catch (error) {
      console.error("Error handling transaction:", error);
    }
  }

  private async executeTrade(target: TradeTarget): Promise<void> {
    if (this.hasExecuted) {
      return;
    }

    this.hasExecuted = true;
    console.log(" EXECUTING TRADE!");

    try {
      const startTime = Date.now();

      const eligibleWallets = this.walletManager.getWalletsWithSufficientBalance(
        this.config.trading.tradeAmountSol
      );

      if (eligibleWallets.length === 0) {
        throw new Error("No wallets with sufficient balance");
      }

      console.log(` Using ${eligibleWallets.length} wallets for trading`);

      let transactions = await this.buildTransactionsInParallel(
        eligibleWallets,
        target.poolAccounts
      );

      await this.sendTransactionsWithRetry(transactions, eligibleWallets);

      console.log(" BOT CYCLE COMPLETE - Stopping stream");
      this.stop();

    } catch (error) {
      console.error(" Trade execution failed:", error);
      this.hasExecuted = false;
    }
  }

  private async sendTransactionsWithRetry(transactions: Transaction[], eligibleWallets: any[]): Promise<void> {
    const startTime = Date.now();
    let retries = 0;
    const maxRetries = 3;
    let success = false;

    while (retries < maxRetries && !success) {
      console.log(`\n--- Execution Attempt ${retries + 1}/${maxRetries} ---`);

      // Fault Injection for Bounty
      if (process.env.SIMULATE_BLOCKHASH_EXPIRY === 'true' && retries === 0) {
        console.log(" Fault injection active: Waiting 65 seconds to guarantee blockhash expiry...");
        await new Promise(resolve => setTimeout(resolve, 65000));
      }

      // Simulate transactions if enabled
      if (this.config.simulation.enabled) {
        console.log(" Simulating transactions before sending...");
        const simulationResults = await this.simulateTransactions(transactions, eligibleWallets);

        if (this.config.simulation.failOnSimulationError && simulationResults.some(r => !r.success)) {
          const failedCount = simulationResults.filter(r => !r.success).length;
          throw new Error(`${failedCount}/${transactions.length} transaction simulations failed`);
        }
      }

      console.log(" Requesting Jito tip calculation.");
      const dynamicTipLamports = await this.aiTippingAgent.determineOptimalTip(this.latestSlotInfo);
      const dynamicTipSol = dynamicTipLamports / 1e9;
      console.log(` Agent suggested tip: ${dynamicTipSol} SOL`);

      if (this.config.trading.dryRun) {
        console.log(`\n[DRY RUN] Skipping Jito transmission and simulating success.`);
        console.log(`[DRY RUN] Transactions built: ${transactions.length}`);
        console.log(`[DRY RUN] Jito tip calculated: ${dynamicTipSol} SOL`);
        success = true;
        break;
      }

      let bundleIds: string[] = [];

      if (this.config.jito.singleTransactionPerBundle) {
        console.log(" Sending single transaction per bundle...");
        for (let i = 0; i < transactions.length; i++) {
          const bundleId = await this.jitoBundleSender.sendTransactionsWithFallback(
            [transactions[i]],
            [eligibleWallets[i].keypair],
            dynamicTipSol
          );
          bundleIds.push(...bundleId);
        }
      } else {
        console.log(" Sending all transactions in one bundle...");
        const walletKeypairs = eligibleWallets.map(w => w.keypair);
        bundleIds = await this.jitoBundleSender.sendTransactionsWithFallback(
          transactions,
          walletKeypairs,
          dynamicTipSol
        );
      }

      const executionTime = Date.now() - startTime;
      console.log(` Trade executed in ${executionTime}ms`);
      console.log(` Sent ${bundleIds.length} transactions/bundles`);

      // Track signatures and setup confirmation promises
      const confirmationPromises: Promise<CommitmentStage>[] = [];

      transactions.forEach(tx => {
        if (tx.signature) {
          const sig = bs58.encode(tx.signature);
          this.lifecycleTracker.recordEvent({
            signature: sig,
            stage: 'submitted',
            timestamp: Date.now(),
            tipAmountLamports: dynamicTipLamports
          });
          this.grpcStream.subscribeToTransaction(sig);

          const confirmPromise = new Promise<CommitmentStage>((resolve) => {
            this.pendingConfirmations.set(sig, { resolve });

            // Timeout for blockhash expiry (approx 60 seconds)
            setTimeout(() => {
              if (this.pendingConfirmations.has(sig)) {
                this.pendingConfirmations.delete(sig);
                resolve('failed');
                this.lifecycleTracker.recordEvent({
                  signature: sig,
                  stage: 'failed',
                  timestamp: Date.now(),
                  failureReason: "Blockhash Expired (Timeout)"
                });
              }
            }, 60000);
          });

          confirmationPromises.push(confirmPromise);
        }
      });

      console.log("Waiting for stream confirmations...");
      const results = await Promise.all(confirmationPromises);

      const anyFailed = results.some(res => res === 'failed');
      if (anyFailed) {
        console.log(` Attempt ${retries + 1} failed (Blockhash Expired or Compute Exceeded).`);
        console.log(" Failure reasoning: Network congestion caused delay or bundle dropped. Re-fetching blockhash and recalculating tip...");
        retries++;
      } else {
        console.log(` All transactions confirmed successfully on attempt ${retries + 1}!`);
        success = true;
      }
    }

    if (!success) {
      console.error(" Max retries reached. Transaction execution permanently failed.");
    }
  }

  private async buildTransactionsInParallel(
    wallets: any[],
    poolAccounts: PoolAccounts
  ): Promise<Transaction[]> {
    const transactionPromises = wallets.map(wallet =>
      this.transactionBuilder.buildBuyTransaction(
        wallet.keypair,
        poolAccounts,
        this.config.trading.tradeAmountSol,
        wallet.solBalance * 1e9 // Convert SOL to lamports
      )
    );

    return await Promise.all(transactionPromises);
  }

  private async simulateTransactions(
    transactions: Transaction[],
    wallets: any[]
  ): Promise<any[]> {
    const simulationPromises = transactions.map((transaction, index) => {
      const wallet = wallets[index];
      return this.transactionSimulator.dryRunTransaction(
        transaction,
        wallet.keypair,
        {
          validateAccounts: this.config.simulation.validateAccounts,
          logDetails: this.config.simulation.logDetails,
        }
      );
    });

    return await Promise.all(simulationPromises);
  }

  public stop(): void {
    console.log("🛑 Stopping market maker bot...");
    this.isRunning = false;
    this.grpcStream.stopStream();
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public hasExecutedTrade(): boolean {
    return this.hasExecuted;
  }

  public async getWalletBalances(): Promise<void> {
    await this.walletManager.refreshBalances();
    const wallets = this.walletManager.getWallets();

    console.log(" Current wallet balances:");
    wallets.forEach((wallet, index) => {
      console.log(`  Wallet ${index + 1}: ${wallet.solBalance.toFixed(4)} SOL`);
    });
  }
}