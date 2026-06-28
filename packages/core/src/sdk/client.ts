import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { config } from "../config.js";
import { logger } from "../common/logger.js";
import { StreamManager } from "../monitor/connection.js";
import { CongestionOracle, LeaderWindowDetector } from "../monitor/telemetry.js";
import { LifecycleTracker } from "../recovery/tracker.js";
import { tipFloorService } from "../dispatch/fees.js";
import { jitoClient, subscribeBundleResults } from "../dispatch/client.js";
import { Agent } from "../recovery/advisor.js";
import {
  BundleDispatcher,
  type AutoLandSubmitOptions,
  type BundleTransaction,
  type AutoLandResult,
} from "../dispatch/sender.js";

const log = logger("sdk");

export interface AutoLandConfig {
  wallet?: Keypair;
  connection?: Connection;
  submit?: boolean;
  maxAttempts?: number;
  confirmTimeoutMs?: number;
  submitCooldownMs?: number;
}

// Re-export types for backward compatibility / caller convenience
export { AutoLandSubmitOptions, BundleTransaction, AutoLandResult };

export class AutoLand {
  private sdkWallet: Keypair;
  private sdkConnection: Connection;
  private submitEnabled: boolean;
  private maxAttempts: number;
  private confirmTimeoutMs: number;
  private submitCooldownMs: number;

  private stream?: StreamManager;
  private oracle?: CongestionOracle;
  private leader?: LeaderWindowDetector;
  private lifecycle?: LifecycleTracker;
  private tipFloor = tipFloorService();
  private agent = new Agent();
  private jito = jitoClient();
  private dispatcher: BundleDispatcher;

  private initialized = false;
  private streamReaderPromise?: Promise<void>;
  private cancelJitoBundleSub?: () => void;

  constructor(cfg: AutoLandConfig = {}) {
    if (!cfg.connection) throw new Error("Connection is required for AutoLand");
    this.sdkConnection = cfg.connection;
    if (cfg.wallet) {
      this.sdkWallet = cfg.wallet as Keypair;
      log.info("AutoLand wallet injected via config");
    } else if (config.wallet.secretKey) {
      log.info("AutoLand wallet derived from config.wallet.secretKey");
      this.sdkWallet = Keypair.fromSecretKey(bs58.decode(config.wallet.secretKey));
    } else {
      log.error("AutoLand wallet is UNDEFINED! process.env.PRIVATE_KEYS was:", { pk: process.env.PRIVATE_KEYS });
      this.sdkWallet = undefined as any;
    }
    this.submitEnabled = cfg.submit ?? true;
    this.maxAttempts = cfg.maxAttempts ?? Number(process.env.LIVE_MAX_ATTEMPTS ?? 5);
    this.confirmTimeoutMs = cfg.confirmTimeoutMs ?? Number(process.env.LIVE_CONFIRM_TIMEOUT_MS ?? 30_000);
    this.submitCooldownMs = cfg.submitCooldownMs ?? Number(process.env.LIVE_SUBMIT_COOLDOWN_MS ?? 20_000);

    this.dispatcher = new BundleDispatcher({
      sdkConnection: this.sdkConnection,
      sdkWallet: this.sdkWallet,
      submitEnabled: this.submitEnabled,
      maxAttempts: this.maxAttempts,
      confirmTimeoutMs: this.confirmTimeoutMs,
      submitCooldownMs: this.submitCooldownMs,
      getStream: () => this.stream,
      getOracle: () => this.oracle,
      getLeader: () => this.leader,
      getLifecycle: () => this.lifecycle,
      tipFloor: this.tipFloor,
      agent: this.agent,
      jito: this.jito
    });
  }

  getStream(): StreamManager | undefined {
    return this.stream;
  }

  getOracle(): CongestionOracle | undefined {
    return this.oracle;
  }

  getLeader(): LeaderWindowDetector | undefined {
    return this.leader;
  }

  getLifecycle(): LifecycleTracker | undefined {
    return this.lifecycle;
  }

  async start(): Promise<void> {
    if (this.initialized) return;
    log.info("Starting AutoLand SDK core...");

    this.stream = new StreamManager();

    if (this.sdkWallet) {
      this.stream.trackAccounts([this.sdkWallet.publicKey.toBase58()]);
    }

    this.oracle = new CongestionOracle();
    this.leader = new LeaderWindowDetector();
    this.lifecycle = new LifecycleTracker(this.sdkConnection, this.stream);

    if (this.sdkWallet) {
      this.stream.trackAccounts([this.sdkWallet.publicKey.toBase58()]);
    }

    await this.stream.start();
    this.initialized = true;

    try {
      this.cancelJitoBundleSub = subscribeBundleResults(
        (res) => {
          const bundleId = res.bundle_id;
          const lifecycle = this.lifecycle;
          if (!lifecycle) return;

          const entry = lifecycle.get(bundleId);
          if (!entry) return;

          if (res.result) {
            if (res.result.accepted) {
              const slot = Number(res.result.accepted.slot);
              log.info("Jito stream: bundle ACCEPTED", { bundleId, slot });
              lifecycle.reconcile(bundleId, "processed", slot);
            } else if (res.result.processed) {
              const slot = Number(res.result.processed.slot);
              log.info("Jito stream: bundle PROCESSED", { bundleId, slot });
              lifecycle.reconcile(bundleId, "processed", slot);
            } else if (res.result.finalized) {
              log.info("Jito stream: bundle FINALIZED", { bundleId });
              lifecycle.reconcile(bundleId, "finalized", entry.stages.confirmed?.slot || entry.stages.processed?.slot || 0);
            } else if (res.result.rejected) {
              const rej = res.result.rejected;
              let reason = "Jito bundle rejected";
              let failClass: "blockhash_expired" | "fee_too_low" | "compute_exceeded" | "leader_skip" | "bundle_dropped" | "simulation_failed" | "jito_api_error" = "bundle_dropped";

              if (rej.simulation_failure) {
                reason = `Simulation failure: ${rej.simulation_failure.msg || ""}`;
                failClass = "simulation_failed";
              } else if (rej.state_auction_bid_rejected) {
                reason = `Bid rejected: ${rej.state_auction_bid_rejected.msg || ""}`;
                failClass = "fee_too_low";
              } else if (rej.winning_batch_bid_rejected) {
                reason = `Winning batch bid rejected: ${rej.winning_batch_bid_rejected.msg || ""}`;
                failClass = "fee_too_low";
              } else if (rej.internal_error) {
                reason = `Jito internal error: ${rej.internal_error.msg || ""}`;
                failClass = "jito_api_error";
              } else if (rej.dropped_bundle) {
                reason = `Jito dropped bundle: ${rej.dropped_bundle.msg || ""}`;
                failClass = "bundle_dropped";
              }

              log.warn("Jito stream: bundle REJECTED", { bundleId, reason });

              lifecycle.fail(bundleId, {
                type: failClass,
                evidence: { reason, detail: rej },
                detectedAtSlot: entry.stages.submitted?.slot || 0,
                ts: new Date().toISOString()
              });
            } else if (res.result.dropped) {
              log.warn("Jito stream: bundle DROPPED", { bundleId, reason: res.result.dropped.reason });
              lifecycle.fail(bundleId, {
                type: "bundle_dropped",
                evidence: { reason: `Jito dropped: ${res.result.dropped.reason}` },
                detectedAtSlot: entry.stages.submitted?.slot || 0,
                ts: new Date().toISOString()
              });
            }
          }
        },
        (err) => {
          log.warn("Jito bundle results subscription error", { err: err.message });
        }
      );
    } catch (err: any) {
      log.warn("Failed to subscribe to Jito bundle results stream", { err: err.message || err });
    }

    this.streamReaderPromise = (async () => {
      let lastTelemetryEmit = 0;
      let lastLeaderPoll = 0;
      let cachedLeaderSlot: number | null = null;
      let lastTipFetchedAt = 0;

      try {
        for await (const ev of this.stream!.queue) {
          if (ev.kind === "slot") {
            this.oracle!.ingest(ev);
            this.lifecycle!.onSlotStatus(Number(ev.slot), ev.status, ev.ts);

            const now = Date.now();

            if (now - lastLeaderPoll > 5_000) {
              lastLeaderPoll = now;
              this.leader!.window()
                .then((w) => { cachedLeaderSlot = w.nextJitoLeaderSlot ?? null; })
                .catch(() => { });
            }

            if (now - lastTelemetryEmit > 400) {
              lastTelemetryEmit = now;

              const tf = this.tipFloor.getCached();
              const tipFloor = tf && tf.fetchedAt !== lastTipFetchedAt ? tf : undefined;
              if (tipFloor) lastTipFetchedAt = tipFloor.fetchedAt;

              if (tipFloor) {
                log.info(`[TIP_FLOOR] Update: ${tipFloor.p50} lamports`);
              }

              if (now - lastLeaderPoll > 4_500) {
                const alphaContention = this.stream?.contentionTracker?.getAlphaContention() ?? 1.0;
                const maxCompetitorTipPerCU = this.stream?.competitorTracker?.getMaxTipPerCU() ?? 0;
                log.info(`[CONTENTION] Live Slot: ${ev.slot} | Alpha Contention: ${alphaContention.toFixed(3)}x | Competitor Max Tip/CU: ${maxCompetitorTipPerCU.toFixed(4)} | Next Leader: ${cachedLeaderSlot ?? '?'}`);
              }
            }
          } else {
            this.lifecycle!.onTxEvent(ev, "processed");
          }
        }
      } catch (err) {
        log.error("Stream reader loop encountered error", { err: String(err) });
      }
    })();
  }

  async stop(): Promise<void> {
    if (!this.initialized) return;
    log.info("Stopping AutoLand SDK core...");
    if (this.cancelJitoBundleSub) {
      try {
        this.cancelJitoBundleSub();
      } catch { /* ignore */ }
      this.cancelJitoBundleSub = undefined;
    }
    await this.stream?.stop();
    this.initialized = false;
    try {
      await this.streamReaderPromise;
    } catch (err) {
      // ignore
    }
  }

  status() {
    return {
      initialized: this.initialized,
      stream: this.stream?.metrics(),
      congestion: this.oracle?.snapshot(),
      contention: this.stream?.contentionTracker?.getAlphaContention()
    };
  }

  trackPoolContention(poolAddress: string): void {
    if (this.stream) {
      this.stream.trackPoolContention(poolAddress);
    } else {
      log.warn("Cannot track pool contention before AutoLand is initialized");
    }
  }

  trackAccounts(pubkeys: string[]): void {
    if (this.stream) {
      this.stream.trackAccounts(pubkeys);
    } else {
      log.warn("Cannot track accounts before AutoLand is initialized");
    }
  }

  async submit(
    txInput: VersionedTransaction | Transaction | TransactionInstruction[] | string | Buffer | BundleTransaction[],
    opts: AutoLandSubmitOptions = {}
  ): Promise<AutoLandResult> {
    if (!this.initialized) {
      log.info("SDK not started; starting automatically...");
      await this.start();
    }
    return this.dispatcher.submit(txInput, opts);
  }
}
