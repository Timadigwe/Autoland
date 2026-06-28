import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { ConfigManager } from "../utils/config";
import { WalletManager } from "../services/wallet-manager";
import { BotConfig, WalletInfo } from "../types/config";
import { RebalanceBuilder } from "../execution/rebalance-builder";
import { PositionEngine } from "./position-engine";
import { Logger } from "../utils/logger";
import { AutoLand, BundleTransaction, resolveWorkspacePath } from "@autoland/core"; // Using the new core SDK

export class DlmmBot {
  private readonly config: BotConfig;
  private readonly connection: Connection;
  private readonly walletManager: WalletManager;
  private readonly rebalanceBuilder: RebalanceBuilder;
  private readonly positionEngine: PositionEngine;
  private readonly logger: Logger;
  private readonly autoland: AutoLand;

  private isRunning = false;
  private isExecuting = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private telemetryTimer: NodeJS.Timeout | null = null;
  private injectFeeTooLow = false;

  constructor() {
    this.config = ConfigManager.getInstance().getConfig();
    this.connection = new Connection(this.config.rpc.url, "processed");
    this.logger = Logger.getInstance();

    this.walletManager = new WalletManager(this.connection);
    this.rebalanceBuilder = new RebalanceBuilder(this.connection, this.config);
    this.positionEngine = new PositionEngine(this.config, this.rebalanceBuilder);

    // Instantiate the intelligent transaction stack
    this.autoland = new AutoLand({
      connection: this.connection,
      maxAttempts: this.config.jito.maxRetries,
    });
  }

  public async initialize(): Promise<void> {
    this.logger.info("Initializing Intelligent DLMM Bot...");
    await this.walletManager.initializeWallets(this.config.wallets.privateKeys);

    const walletCount = this.walletManager.getWalletCount();
    if (walletCount === 0) throw new Error("No wallets configured");

    // Start the AutoLand core observation loops (stream, congestion, tip floor)
    await this.autoland.start();

    // Start tracking our target pool for contention / Alpha_Contention scalar
    this.autoland.trackPoolContention(this.config.dlmm.targetPool);

    // Dynamic wallet tracking inside Yellowstone/stream connection
    const tradingWallets = this.walletManager.getWallets().map((w) => w.publicKey);
    this.autoland.trackAccounts(tradingWallets);

    this.logger.info("Bot initialized successfully");
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info("Starting DLMM bot...");

    this.pollTimer = setInterval(() => {
      this.runPositionCycle().catch((error) => {
        this.logger.error(`[ENGINE] Position cycle error: ${error}`);
      });
    }, this.config.engine.pollIntervalMs);

    // Setup embedded telemetry collection to avoid gRPC connection limits
    const logFile = resolveWorkspacePath("telemetry.csv");
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(logFile, "timestamp,slot,skip_rate,latency_ms,congestion_mult,tip_p25,tip_p50,tip_p75,tip_p95,tip_p99\n");
    }

    let lastSlot = 0;
    this.telemetryTimer = setInterval(() => {
      try {
        const status = this.autoland.status();
        const congestion = status.congestion;
        const autolandAny = this.autoland as any;
        const tipFloor = autolandAny.tipFloor?.getCached();
        const currentSlot = autolandAny.leader?.windowCache?.currentSlot || 0;

        if (congestion && tipFloor && currentSlot > lastSlot) {
          lastSlot = currentSlot;
          const timestamp = new Date().toISOString();
          const line = [
            timestamp,
            currentSlot,
            congestion.skipRate.toFixed(4),
            congestion.p2cMsP50,
            congestion.congestionMultiplier.toFixed(4),
            tipFloor.p25,
            tipFloor.p50,
            tipFloor.p75,
            tipFloor.p95,
            tipFloor.p99
          ].join(",") + "\n";
          fs.appendFileSync(logFile, line);
        }
      } catch (err) {
        // Ignore telemetry errors so it doesn't crash the bot
      }
    }, 500);
  }

  public async stop(): Promise<void> {
    this.logger.info("Stopping DLMM bot...");
    this.isRunning = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    await this.autoland.stop();
  }

  private getActiveWallet(): WalletInfo | undefined {
    return this.walletManager.getWallets()[0];
  }

  private async runPositionCycle(): Promise<void> {
    if (this.isExecuting) return;

    const wallet = this.getActiveWallet();
    if (!wallet) return;

    this.isExecuting = true;
    try {
      const evaluation = await this.positionEngine.evaluate(wallet.keypair);

      if (evaluation.shouldDeploy || evaluation.shouldRebalance) {
        const action = evaluation.shouldDeploy ? "deploy initial position" : "rebalance";
        this.logger.info(`[ENGINE] Triggering ${action}`);

        const buildFn = evaluation.shouldDeploy
          ? () => this.rebalanceBuilder.buildDeployTransactions(wallet.keypair)
          : () => this.rebalanceBuilder.buildRebalanceTransactions(wallet.keypair);

        const buildResult = await buildFn();

        // Convert to BundleTransaction format
        const bundleTxs: BundleTransaction[] = buildResult.transactions.map(t => {
          // Exclude the bot's main wallet from extraSigners since AutoLand automatically signs with it
          const extraSigners = t.signers.filter(s => !s.publicKey.equals(wallet.keypair.publicKey));

          if (t.tx instanceof VersionedTransaction) {
            throw new Error("VersionedTransactions are not supported for bundle dynamic CU sizing.");
          }

          return {
            instructions: t.tx.instructions,
            signers: extraSigners.length > 0 ? extraSigners : undefined
          };
        });

        const submitOpts: any = {
          urgency: "high"
        };

        if (this.injectFeeTooLow) {
          this.logger.warn("[TEST] Low-fee injection is ENABLED. Overriding next attempt tip with 1,000 lamports (Jito will drop this)...");
          submitOpts.customTipLamports = 1000;
          this.injectFeeTooLow = false; // Reset so retries use AI-calculated tips
        }

        this.logger.info(`Submitting ${bundleTxs.length} separate transactions to AutoLand as one atomic Jito bundle...`);
        const result = await this.autoland.submit(bundleTxs, submitOpts);

        if (result.landed) {
          this.logger.info(`[SUCCESS] Atomic bundle landed @ slot ${result.slot}`);
        } else {
          this.logger.error(`[FAILURE] AutoLand max retries exhausted: ${result.error || 'Unknown error'}`);
        }
      }
    } catch (err) {
      this.logger.error(`[ENGINE] Execution failed: ${err}`);
    } finally {
      this.isExecuting = false;
    }
  }

  public toggleFeeTooLowInjection(): void {
    this.injectFeeTooLow = !this.injectFeeTooLow;
    this.logger.info(`[TEST] Jito low-fee injection toggled: ${this.injectFeeTooLow ? "ENABLED (Will apply to next rebalance)" : "DISABLED"}`);
  }
}
