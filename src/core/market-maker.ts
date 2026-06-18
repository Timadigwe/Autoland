import { Connection, Keypair, Transaction, PublicKey } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { ConfigManager } from "../utils/config";
import { WalletManager } from "../services/wallet-manager";
import { GrpcStreamService } from "../services/grpc-stream";
import { MeteoraTransactionParser } from "../services/transaction-parser";
import { JitoBundleSender } from "../services/jito-bundle-sender";
import { TransactionSimulator } from "../services/transaction-simulator";
import { BotConfig, WalletInfo } from "../types/config";
import { DlmmManager } from "../services/dlmm-manager";
import { UnifiedExecutionAgent, FailureTelemetry } from "../services/unified-execution-agent";
import { LifecycleTracker, CommitmentStage } from "../services/lifecycle-tracker";
import bs58 from "bs58";

export class DlmmMarketMaker {
  private config: BotConfig;
  private connection: Connection;
  private walletManager: WalletManager;
  private grpcStream: GrpcStreamService;
  private transactionParser: MeteoraTransactionParser;
  private jitoBundleSender: JitoBundleSender;
  private transactionSimulator: TransactionSimulator;
  private dlmmManager: DlmmManager;
  private unifiedAgent: UnifiedExecutionAgent;
  private lifecycleTracker: LifecycleTracker;

  private isRunning: boolean = false;
  private isExecuting: boolean = false;
  private pendingConfirmations: Map<string, { resolve: (result: { status: CommitmentStage, error?: any }) => void }> = new Map();
  private recentTips: number[] = [];
  private tipAccountBalances: Map<string, number> = new Map();

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
    this.jitoBundleSender = new JitoBundleSender(this.config, this.connection);
    this.transactionSimulator = new TransactionSimulator(this.connection, this.config);
    this.dlmmManager = new DlmmManager(this.connection);

    // AI Landing Stack
    this.unifiedAgent = new UnifiedExecutionAgent();
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
      if (totalBalance < requiredBalance && !this.config.trading.dryRun) {
        throw new Error(`Insufficient balance. Required: ${requiredBalance} SOL`);
      }

      console.log(" Bot initialized successfully");
    } catch (error) {
      console.error(" Failed to initialize bot:", error);
      throw error;
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    console.log(" Starting DLMM Market Maker Engine...");
    this.isRunning = true;
    this.isExecuting = false;

    // Start the GRPC Stream for slots, transactions, and lifecycle statuses
    await this.grpcStream.startStream(
      this.handleTransaction.bind(this),
      this.handleSlot.bind(this),
      this.handleTransactionStatus.bind(this),
      this.handleAccount.bind(this)
    );
  }

  /**
   * Evaluates the Fixed-Distance trigger natively designed for Meteora's bins.
   * If the activeBin drifts > 5 bins from the center of our position, we instantly pull and re-center.
   */
  private async checkRebalanceTrigger(): Promise<void> {
    if (this.isExecuting) return;

    try {
      const wallets = this.walletManager.getWallets();
      if (wallets.length === 0) return;
      const activeWallet = wallets[0];

      const { activeBin, minBin, maxBin } = await this.dlmmManager.getActiveBinAndPositionLimits(activeWallet.keypair);

      // If no position exists, deploy immediately (cold start)
      if (minBin === null || maxBin === null) {
        console.log(`[DLMM ENGINE] No active position found. Deploying initial Curve strategy...`);
        await this.executeTrade("Curve", 11);
        return;
      }

      // Fixed-Distance Math (0ms latency)
      const positionCenter = Math.floor((minBin + maxBin) / 2);
      const drift = Math.abs(activeBin - positionCenter);

      if (drift > 5) {
        console.log(`[DLMM ENGINE] Price Drift Detected! ActiveBin (${activeBin}) is ${drift} bins away from our center (${positionCenter}).`);
        console.log(`[DLMM ENGINE] Triggering instantaneous swapless rebalance...`);
        await this.executeTrade("Curve", 11);
      } else {
        console.log(`[DLMM ENGINE] Position optimal. Drift is only ${drift} bins. HOLDING.`);
      }

    } catch (e) {
      console.error("Error in DLMM trigger loop:", e);
    }
  }

  private async executeTrade(strategy: "Spot" | "Curve" | "BidAsk", binCount: number): Promise<void> {
    if (this.isExecuting) return;
    this.isExecuting = true;

    try {
      const activeWallet = this.walletManager.getWallets()[0];
      if (!activeWallet) return;

      console.log(`[ENGINE] Constructing ${strategy} [${binCount} Bins] Rebalance...`);
      
      // Pass a strategy factory closure directly to the robust retry wrapper
      await this.executeWithRetry(async () => {
         return await this.dlmmManager.calculateRebalanceStrategy(activeWallet.keypair, strategy, binCount);
      }, activeWallet);

    } catch (error) {
      console.error("Trade execution construction failed:", error);
    } finally {
      this.isExecuting = false;
    }
  }

  private async executeWithRetry(strategyBuilder: () => Promise<Transaction[]>, activeWallet: WalletInfo): Promise<void> {
    const startTime = Date.now();
    let retries = 0;
    const maxRetries = 3;
    let success = false;
    let currentTipLamports = this.unifiedAgent.getBaselineTipLamports();

    while (retries < maxRetries && !success) {
      console.log(`\n--- Execution Attempt ${retries + 1}/${maxRetries} ---`);

      // 1. Tip Intelligence (Instant read from Unified Agent or mutated state)
      const dynamicTipSol = currentTipLamports / 1e9;
      console.log(`[AI TIP] Utilizing override tip: ${dynamicTipSol} SOL (${currentTipLamports} lamports)`);

      if (this.config.trading.dryRun) {
        console.log(`[DRY RUN] Bypassing Jito transmission. Success simulated.`);
        success = true;
        break;
      }
      
      // 2. BUILD TRANSACTIONS ON EVERY RETRY
      // This completely solves the blockhash expiration issue AND the ephemeral signature wipe issue,
      // because we re-run the SDK math, fetch the absolute newest blockhash, and generate fresh keypairs every single time!
      let transactions: Transaction[];
      try {
         transactions = await strategyBuilder();
      } catch (e) {
         console.error("[ENGINE] Failed to build strategy transactions. Aborting execution:", e);
         break;
      }

      // 3. Pre-Subscribe to Lifecycle Tracking
      const confirmationPromises: Promise<{ status: CommitmentStage, error?: any }>[] = [];
      transactions.forEach(tx => {
        if (tx.signature) {
          const sig = bs58.encode(tx.signature);
          this.lifecycleTracker.recordEvent({ signature: sig, stage: 'submitted', timestamp: Date.now(), tipAmountLamports: currentTipLamports });
          this.grpcStream.subscribeToTransaction(sig);

          const confirmPromise = new Promise<{ status: CommitmentStage, error?: any }>((resolve) => {
            this.pendingConfirmations.set(sig, { resolve });

            // Blockhash Expiry Timeout (45 seconds)
            setTimeout(() => {
              if (this.pendingConfirmations.has(sig)) {
                this.pendingConfirmations.delete(sig);
                resolve({ status: 'failed', error: "Timeout" });
                this.lifecycleTracker.recordEvent({ signature: sig, stage: 'failed', timestamp: Date.now(), failureReason: "BlockhashExpired" });
              }
            }, 45000);
          });
          confirmationPromises.push(confirmPromise);
        }
      });

      // 4. Submission
      let bundleIds: string[] = [];
      const walletKeypairs = transactions.map(() => activeWallet.keypair);
      let jitoSubmissionError: any = null;

      try {
        bundleIds = await this.jitoBundleSender.sendTransactionsWithFallback(transactions, walletKeypairs, dynamicTipSol);
        console.log(`[JITO] Bundle sent to Block Engine. Awaiting stream confirmation...`);
        
        // Asynchronous Jito Polling Loop
        // We poll Jito every 2.5 seconds to see if the bundle was silently dropped.
        // This allows us to instantly short-circuit the 45-second timeout.
        if (bundleIds.length > 0) {
          const bundleId = bundleIds[0];
          const pollJito = async () => {
            while (this.pendingConfirmations.has(bundleId)) {
               await new Promise(r => setTimeout(r, 2500)); // Poll every 2.5s to respect rate limits
               
               if (!this.pendingConfirmations.has(bundleId)) break; // Already resolved by gRPC stream

               const status = await this.jitoBundleSender.getBundleStatus(bundleId);
               if (status && status.err) {
                 console.log(`[JITO] Bundle dropped by Block Engine. Reason: ${JSON.stringify(status.err)}`);
                 const pending = this.pendingConfirmations.get(bundleId);
                 if (pending) {
                   pending.resolve({ status: 'failed', error: status.err });
                   this.pendingConfirmations.delete(bundleId);
                 }
                 break;
               }
            }
          };
          pollJito().catch(err => console.error("Jito polling error:", err));
        }

      } catch (e: any) {
        console.error("[JITO] Failed to submit bundle:", e.message || e);
        jitoSubmissionError = e;
        
        // If Jito threw an error instantly (like Simulation Failed), we MUST instantly short-circuit the 45 second timeout!
        transactions.forEach(tx => {
          if (tx.signature) {
             const sig = bs58.encode(tx.signature);
             const pending = this.pendingConfirmations.get(sig);
             if (pending) {
                pending.resolve({ status: 'failed', error: e });
                this.pendingConfirmations.delete(sig);
             }
          }
        });
      }

      // 5. Await Results
      if (confirmationPromises.length === 0) {
        console.error("[LIFECYCLE] FATAL ERROR: No transaction signatures were tracked. Aborting execution to prevent ghost confirmations.");
        throw new Error("Empty signature array after transaction signing.");
      }

      const results = await Promise.all(confirmationPromises);
      const failedResult = results.find(res => res.status === 'failed');

      // 6. Failure Reasoning & Payload Mutation
      if (failedResult) {
        console.warn(`[LIFECYCLE] Transaction failed to land. Engaging AI Failure Agent...`);

        // Construct real telemetry based on actual failure cause
        let errorType: FailureTelemetry['errorType'] = "Unknown";
        let errorMessage = "Transaction dropped from mempool";
        
        if (failedResult.error === "Timeout") {
          errorType = "BlockhashExpired";
          errorMessage = "Transaction dropped from mempool due to blockhash expiry timeout (Tip was likely too low or network congested).";
        } else if (failedResult.error && failedResult.error.message && failedResult.error.message.includes("Jito API Simulation Error")) {
          errorType = "SimulationError";
          errorMessage = failedResult.error.message;
        } else if (JSON.stringify(failedResult.error || "").toLowerCase().includes("slippage") || JSON.stringify(failedResult.error || "").toLowerCase().includes("0x11")) {
          errorType = "SlippageExceeded";
          errorMessage = JSON.stringify(failedResult.error);
        } else if (failedResult.error) {
          // If the error object came from Jito's err response, it's a SimulationError inside their pipeline
          errorType = "SimulationError";
          errorMessage = failedResult.error.message || JSON.stringify(failedResult.error);
        }

        const telemetry: FailureTelemetry = {
          errorType,
          errorMessage,
          slotFired: 0,
          currentSlot: 0
        };

        const decision = await this.unifiedAgent.analyzeFailureSequence(telemetry, currentTipLamports, retries + 1);

        if (decision.action === "HALT") {
          console.error(`[AI REASONING] Agent dictated HALT. Reason: ${decision.reasoning}. Abandoning trade.`);
          break;
        }

        if (decision.action === "RETRY" && decision.mutations) {
          console.log(`[AI REASONING] Agent dictates RETRY. Reason: ${decision.reasoning}.`);
          if (decision.mutations.refreshBlockhash) {
            console.log(`[MUTATION] Regenerating strategy from scratch for retry payload...`);
            // We just loop around. The while loop will naturally call strategyBuilder() again!
          }
          if (decision.mutations.overrideTipLamports) {
            currentTipLamports = decision.mutations.overrideTipLamports;
          }
        }
        retries++;
      } else {
        console.log(`[LIFECYCLE] ✅ All transactions Confirmed on attempt ${retries + 1}!`);
        success = true;
      }
    }
  }

  // ==== Stream Handlers ====

  private handleSlot(data: any): void {
    if (data?.slot?.slot) {
      const currentSlot = typeof data.slot.slot === 'string' ? parseInt(data.slot.slot, 10) : data.slot.slot;

      // Every 25 slots (~10 seconds), check our DLMM Engine trigger
      if (currentSlot % 25 === 0) {
        this.checkRebalanceTrigger().catch(console.error);
      }
    }
  }

  private handleTransactionStatus(data: any): void {
    if (data?.transactionStatus?.transactionStatus) {
      const status = data.transactionStatus.transactionStatus;
      const signature = bs58.encode(Buffer.from(data.transactionStatus.signature, 'base64'));
      const error = status.err;

      let stage: CommitmentStage = 'processed';
      if (error) stage = 'failed';
      else {
        const rawStatus = data.transactionStatus.confirmationStatus || 'processed';
        if (rawStatus === 'finalized') stage = 'finalized';
        else if (rawStatus === 'confirmed') stage = 'confirmed';
      }

      this.lifecycleTracker.recordEvent({ signature, stage, timestamp: Date.now(), failureReason: error ? JSON.stringify(error) : undefined });

      const pending = this.pendingConfirmations.get(signature);
      if (pending) {
        pending.resolve({ status: stage, error });
        this.pendingConfirmations.delete(signature);
      }
    }
  }

  private handleAccount(data: any): void {
    // Deprecated retail tracking. The UnifiedExecutionAgent tracks competitors directly in handleTransaction.
  }

  private async handleTransaction(data: any): Promise<void> {
    // Competitor tip extraction
    const competitorTip = this.transactionParser.extractCompetitorTip(data);
    if (competitorTip) {
       this.unifiedAgent.recordCompetitorTip(competitorTip);
       console.log(`[MEV TIP TRACKER] Competitor paid ${competitorTip} lamports to DLMM pool! Adjusting baseline.`);
    }
  }

  public async testJitoFailure(): Promise<void> {
    console.log("\n[FAULT INJECTION] Initiating autonomous retry failure test...");
    const activeWallet = this.walletManager.getWallets()[0];
    if (!activeWallet) return;

    const tx = new Transaction().add({
      keys: [{ pubkey: activeWallet.keypair.publicKey, isSigner: true, isWritable: true }],
      programId: new PublicKey("11111111111111111111111111111111"),
      data: Buffer.from([]),
    });
    tx.feePayer = activeWallet.keypair.publicKey;

    // Inject a deliberately old/expired blockhash to force the retry loop
    tx.recentBlockhash = "11111111111111111111111111111111";

    await this.executeWithRetry(async () => { return [tx]; }, activeWallet);
  }

  public stop(): void {
    console.log("🛑 Stopping DLMM engine...");
    this.isRunning = false;
    this.grpcStream.stopStream();
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