import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";

import { config } from "../config.js";
import { StreamManager } from "../stream/manager.js";
import { CongestionOracle, type CongestionSnapshot } from "../network/congestion.js";
import { LeaderWindowDetector, type LeaderWindow } from "../network/leader.js";
import { LifecycleTracker } from "../lifecycle/tracker.js";
import { classifyFailure } from "../lifecycle/classifier.js";
import { tipFloorService } from "../tips/tipFloor.js";
import { computeTip } from "../tips/model.js";
import {
  buildBundle,
  fetchConfirmedBlockhash,
  type BlockhashInfo,
  type BuiltBundle,
} from "../bundle/builder.js";
import { submitBundle, type SubmitResult } from "../bundle/submitter.js";
import { jitoClient } from "../jito/client.js";
import { Agent } from "../agent/index.js";
import { db } from "../db/index.js";
import type { AgentInput } from "../agent/types.js";
import type { FailureRecord, LifecycleEntry } from "../lifecycle/types.js";
import { logger } from "../util/log.js";

const log = logger("sdk");

export interface AutoLandConfig {
  wallet?: Keypair;
  connection?: Connection;
  submit?: boolean;
  maxAttempts?: number;
  confirmTimeoutMs?: number;
  submitCooldownMs?: number;
}

export interface AutoLandSubmitOptions {
  urgency?: "normal" | "high";
  customTipLamports?: number;
  simulateFault?: "blockhash_expired" | "fee_too_low" | "compute_exceeded" | "leader_skip" | "slippage_exceeded";
  remainingTipBudgetLamports?: number;
  extraSigners?: Keypair[];
}

export interface BundleTransaction {
  instructions: TransactionInstruction[];
  signers?: Keypair[];
}

export interface AutoLandResult {
  bundleId: string;
  landed: boolean;
  signature?: string;
  slot?: number;
  lifecycle: LifecycleEntry;
  error?: string;
}

interface AttemptCtx {
  attempt: number;
  history: Array<{ attempt: number; outcome: string }>;
}

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

  private initialized = false;
  private streamReaderPromise?: Promise<void>;

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
    this.maxAttempts = cfg.maxAttempts ?? Number(process.env.LIVE_MAX_ATTEMPTS ?? 3);
    this.confirmTimeoutMs = cfg.confirmTimeoutMs ?? Number(process.env.LIVE_CONFIRM_TIMEOUT_MS ?? 30_000);
    this.submitCooldownMs = cfg.submitCooldownMs ?? Number(process.env.LIVE_SUBMIT_COOLDOWN_MS ?? 20_000);
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

  /** Initialize the Yellowstone stream manager and other background observation loops */
  async start(): Promise<void> {
    if (this.initialized) return;
    log.info("Starting AutoLand SDK core...");

    this.stream = new StreamManager();
    
    // Pre-register our wallet so we don't trigger dynamic resubscribes later
    // Dynamic resubscribes over HTTP2 often cause Triton/Yellowstone proxy to throw RESOURCE_EXHAUSTED
    if (this.sdkWallet) {
      this.stream.trackAccounts([this.sdkWallet.publicKey.toBase58()]);
    }

    this.oracle = new CongestionOracle();
    this.leader = new LeaderWindowDetector();
    this.lifecycle = new LifecycleTracker();

    if (this.sdkWallet) {
      this.stream.trackAccounts([this.sdkWallet.publicKey.toBase58()]);
    }

    await this.stream.start();
    this.initialized = true;

    // Drain the stream so the oracle/lifecycle stay live.
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

            // Refresh leader window every 5 s (fire-and-forget)
            if (now - lastLeaderPoll > 5_000) {
              lastLeaderPoll = now;
              this.leader!.window()
                .then((w) => { cachedLeaderSlot = w.nextJitoLeaderSlot ?? null; })
                .catch(() => { });
            }

            // Emit telemetry at ~400 ms cadence to match frontend polling
            if (now - lastTelemetryEmit > 400) {
              lastTelemetryEmit = now;
              const snap = this.oracle!.snapshot();

              // Include tip floor only when it has changed since last emission
              const tf = this.tipFloor.getCached();
              const tipFloor = tf && tf.fetchedAt !== lastTipFetchedAt ? tf : undefined;
              if (tipFloor) lastTipFetchedAt = tipFloor.fetchedAt;

              // Telemetry emission removed.
              // Log local tip floor:
              if (tipFloor) {
                log.info(`[TIP_FLOOR] Update: ${tipFloor.p50} lamports`);
              }
              
              // Surface the health telemetry to the user periodically (every ~5 seconds)
              if (now - lastLeaderPoll > 4_500) {
                const alphaContention = this.stream?.contentionTracker?.getAlphaContention() ?? 1.0;
                log.info(`[CONTENTION] Live Slot: ${ev.slot} | Alpha Contention: ${alphaContention.toFixed(3)}x | Next Leader: ${cachedLeaderSlot ?? '?'}`);
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

  /** Stop background observation loops */
  async stop(): Promise<void> {
    if (!this.initialized) return;
    log.info("Stopping AutoLand SDK core...");
    await this.stream?.stop();
    this.initialized = false;
    try {
      await this.streamReaderPromise;
    } catch (err) {
      // ignore
    }
  }

  /** Get the current status of the network observation stream */
  status() {
    return {
      initialized: this.initialized,
      stream: this.stream?.metrics(),
      congestion: this.oracle?.snapshot(),
      contention: this.stream?.contentionTracker?.getAlphaContention()
    };
  }

  /**
   * Track contention for a specific pool address
   */
  trackPoolContention(poolAddress: string): void {
    if (this.stream) {
      this.stream.trackPoolContention(poolAddress);
    } else {
      log.warn("Cannot track pool contention before AutoLand is initialized");
    }
  }

  /**
   * Hand a transaction to AutoLand. It automatically tips, bundles, submits,
   * tracks landing, and AI-retries on failure.
   */
  async submit(
    txInput: VersionedTransaction | Transaction | TransactionInstruction[] | string | Buffer | BundleTransaction[],
    opts: AutoLandSubmitOptions = {}
  ): Promise<AutoLandResult> {
    // 1. Ensure stack is started
    if (!this.initialized) {
      log.info("SDK not started; starting automatically...");
      await this.start();
    }

    // 2. Parse transaction input format
    const parsed = this.parseTransactionInput(txInput);

    // Dynamically track all signing accounts in the Yellowstone stream to ensure we catch landing events
    if (this.stream) {
      const keys: string[] = [];
      if (parsed instanceof VersionedTransaction) {
        const numSignatures = parsed.message.header.numRequiredSignatures;
        for (let i = 0; i < numSignatures; i++) {
          const key = parsed.message.staticAccountKeys[i];
          if (key) keys.push(key.toBase58());
        }
      } else if (parsed instanceof Transaction) {
        for (const signature of parsed.signatures) {
          if (signature.publicKey) {
            keys.push(signature.publicKey.toBase58());
          }
        }
      }
      if (keys.length > 0) {
        log.info("Dynamically tracking accounts on stream", { accounts: keys });
        this.stream.trackAccounts(keys);
      }
    }

    // 3. Track is-presigned flag
    const isPresigned = !(Array.isArray(parsed));

    // 4. Run submit-retry loop
    return this.runOneSubmitAttempt({ attempt: 1, history: [] }, parsed, isPresigned, opts);
  }

  private parseTransactionInput(
    txInput: VersionedTransaction | Transaction | TransactionInstruction[] | string | Buffer | BundleTransaction[]
  ): VersionedTransaction | Transaction | TransactionInstruction[] | BundleTransaction[] {
    if (Array.isArray(txInput)) {
      return txInput;
    }
    if (txInput instanceof VersionedTransaction || txInput instanceof Transaction) {
      return txInput;
    }

    let buffer: Buffer;
    if (typeof txInput === "string") {
      try {
        buffer = Buffer.from(txInput, "base64");
      } catch {
        try {
          buffer = Buffer.from(bs58.decode(txInput));
        } catch {
          throw new Error("Invalid transaction encoding: string must be base64 or base58");
        }
      }
    } else if (Buffer.isBuffer(txInput) || (txInput as any) instanceof Uint8Array) {
      buffer = Buffer.from(txInput);
    } else {
      throw new Error("Invalid transaction input type");
    }

    // Try deserializing as VersionedTransaction first, fallback to legacy Transaction
    try {
      return VersionedTransaction.deserialize(buffer);
    } catch {
      try {
        return Transaction.from(buffer);
      } catch (err) {
        throw new Error(`Failed to deserialize transaction: ${String(err)}`);
      }
    }
  }

  private async runOneSubmitAttempt(
    ctx: AttemptCtx,
    parsed: VersionedTransaction | Transaction | TransactionInstruction[] | BundleTransaction[],
    isPresigned: boolean,
    opts: AutoLandSubmitOptions,
    override?: { newTipLamports?: number; submitAtSlot?: number }
  ): Promise<AutoLandResult> {
    const tf = await this.tipFloor.get();
    const congestion = this.oracle!.snapshot();

    // Determine Jito tip account
    const tipAccount = await this.pickTipAccount();

    const alphaContention = this.stream?.contentionTracker?.getAlphaContention() ?? 1.0;

    // Price tip dynamically
    let tipLamports = override?.newTipLamports != null
      ? this.clampTip(override.newTipLamports, tf.p25)
      : opts.customTipLamports != null
        ? this.clampTip(opts.customTipLamports, tf.p25)
        : computeTip({
          tipFloor: tf,
          congestionMultiplier: congestion.congestionMultiplier,
          alphaContention,
          cuScalar: 1.0, // Initial default scalar
          urgency: opts.urgency ?? "normal"
        }).lamports;

    // Fetch confirmed leader window info to track submission targets
    let win: LeaderWindow | undefined;
    try {
      win = await this.leader!.window();
    } catch (err) {
      log.debug("leader window fetch failed in submit, using slot fallback", { err: String(err) });
    }

    const currentSlot = win?.currentSlot ?? (await this.sdkConnection.getSlot("confirmed"));
    const targetLeaderSlot = win?.nextJitoLeaderSlot ?? (currentSlot + 4);

    // Build the bundle
    let built: BuiltBundle;
    
    // Helper to check if parsed is BundleTransaction[]
    const isBundleTransactionArray = (arr: any[]): arr is BundleTransaction[] => {
      return arr.length > 0 && 'instructions' in arr[0];
    };

    if (Array.isArray(parsed)) {
      if (!this.sdkWallet) {
        throw new Error("WALLET_SECRET_KEY is required to sign raw instructions.");
      }
      
      if (isBundleTransactionArray(parsed)) {
        // Multi-transaction bundle!
        built = await this.buildBundleFromMultipleTxs(parsed, tipLamports, tipAccount);
      } else {
        // Single transaction built from instructions
        built = await this.buildBundleFromInstructions(parsed as TransactionInstruction[], tipLamports, tipAccount, opts.extraSigners);
      }
    } else {
      built = await this.buildBundleFromTx(parsed, tipLamports, tipAccount);
    }

    if (!this.submitEnabled) {
      log.info("AutoLand SDK: submit disabled (dry-run). Built bundle info:", {
        attempt: ctx.attempt,
        tipLamports,
        signatures: built.signatures,
      });
      return {
        bundleId: `dry_run_${Math.random().toString(36).substring(2, 10)}`,
        landed: false,
        lifecycle: {
          bundle_id: "dry_run",
          signatures: built.signatures,
          tip_lamports: tipLamports,
          tip_account: tipAccount,
          attempt: ctx.attempt,
          stages: {},
          deltas_ms: {},
          failure: null,
          confirmed_via: null,
        },
      };
    }

    // Submit bundle
    let result: any;
    if (opts.simulateFault && ctx.attempt === 1) {
      const generatedId = `sim_bundle_${Math.random().toString(36).substring(2, 11)}`;
      log.info("Simulating fault: skipping Jito RPC submission", { bundleId: generatedId, fault: opts.simulateFault });
      result = {
        bundleId: generatedId,
        signatures: built.signatures,
        tipLamports: built.tipLamports,
        tipAccount: built.tipAccount,
        submittedAt: Date.now(),
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
      };
      this.lifecycle!.track(result, ctx.attempt, currentSlot);
    } else {
      // --- CRITICAL FIX START ---
      if (override?.submitAtSlot) {
        log.info(`Agent instructed to pause execution until slot ${override.submitAtSlot}. Current slot: ${currentSlot}`);
        let nowSlot = currentSlot;
        while (nowSlot < override.submitAtSlot) {
          await new Promise(r => setTimeout(r, 100));
          const w = await this.leader!.window().catch((err) => {
            log.warn(`[WARN] Jito API error while waiting for slot: ${err.message || err}`);
            return null;
          });
          nowSlot = w?.currentSlot ?? nowSlot;
        }
      }

      log.info(`Awaiting Jito inSubmitWindow before firing bundle...`);
      let isWindowOpen = false;
      let finalWin = win;
      while (!isWindowOpen) {
        finalWin = await this.leader!.window().catch((err) => {
          log.error(`[ERROR] Jito API poll failed (e.g. 429 Rate Limit): ${err.message || err}`);
          return undefined;
        });
        
        if (finalWin?.inSubmitWindow) {
          isWindowOpen = true;
        } else {
          // If we hit an API error (undefined), backoff for 5s to avoid 429 spam
          await new Promise(r => setTimeout(r, finalWin === undefined ? 5000 : 100));
        }
      }
      log.info(`inSubmitWindow is true! Firing bundle at slot ${finalWin?.currentSlot}`);
      // --- CRITICAL FIX END ---

      // Pre-flight Simulation Check
      log.info(`Running pre-flight bundle simulation locally...`);
      let simRes;
      try {
        simRes = await this.simulateBundleLocally(built.encodedTxs);
      } catch (err) {
        log.warn("Local simulateBundle request failed, proceeding anyway", { err: String(err) });
      }

      // log.info(`Pre-flight simulation response: ${JSON.stringify(simRes)}`);

      // Dynamic CU Sizing based on simulation results
      if (simRes && simRes.result?.value?.summary === "succeeded" && Array.isArray(parsed)) {
        const results = simRes.result.value.transactionResults;
        
        if (isBundleTransactionArray(parsed)) {
          // Dynamic resizing for MULTIPLE transactions in a bundle
          let modified = false;
          const optimizedLimits: number[] = [];
          
          for (let i = 0; i < parsed.length; i++) {
            const txResult = results[i];
            let unitsConsumed = txResult?.unitsConsumed;
            if (unitsConsumed && unitsConsumed > 0) {
              optimizedLimits.push(Math.ceil(unitsConsumed * 1.10));
              modified = true;
            } else {
              optimizedLimits.push(1_400_000); // Fallback
            }
          }
          
          if (modified) {
            log.info(`[OPTIMIZATION] Dynamic CU sizing for multi-tx bundle: ${optimizedLimits.join(', ')}`);
            
            // Recalculate tip based on CU scalar
            if (opts.customTipLamports == null && override?.newTipLamports == null) {
              const totalCUs = optimizedLimits.reduce((a, b) => a + b, 0);
              const cuScalar = Math.max(0.1, totalCUs / 50_000); // Scale relative to a standard 50k CU swap
              
              tipLamports = computeTip({
                tipFloor: tf,
                congestionMultiplier: congestion.congestionMultiplier,
                alphaContention,
                cuScalar,
                urgency: opts.urgency ?? "normal"
              }).lamports;
              log.info(`[OPTIMIZATION] Dynamic tip recalculation (CU Scalar: ${cuScalar.toFixed(3)}, Alpha: ${alphaContention.toFixed(3)}) -> ${tipLamports} lamports`);
            }
            
            built = await this.buildBundleFromMultipleTxs(parsed, tipLamports, tipAccount, optimizedLimits);
          }
        } else {
          // Dynamic resizing for a SINGLE transaction bundle
          const mainTxResult = results.length > 1 ? results[1] : results[0]; // If bundled with tip, usually index 1 or 0
          
          let unitsConsumed = mainTxResult?.unitsConsumed;
          if (!unitsConsumed && results[0]?.unitsConsumed) {
            unitsConsumed = results[0].unitsConsumed;
          }

          if (unitsConsumed && unitsConsumed > 0) {
            const optimizedLimit = Math.ceil(unitsConsumed * 1.10);
            log.info(`[OPTIMIZATION] Dynamic CU sizing: Simulation consumed ${unitsConsumed} CU. Shrinking bundle limit to ${optimizedLimit} CU.`);
            
            // Recalculate tip based on CU scalar
            if (opts.customTipLamports == null && override?.newTipLamports == null) {
              const cuScalar = Math.max(0.1, optimizedLimit / 50_000); // Scale relative to a standard 50k CU swap
              tipLamports = computeTip({
                tipFloor: tf,
                congestionMultiplier: congestion.congestionMultiplier,
                alphaContention,
                cuScalar,
                urgency: opts.urgency ?? "normal"
              }).lamports;
              log.info(`[OPTIMIZATION] Dynamic tip recalculation (CU Scalar: ${cuScalar.toFixed(3)}, Alpha: ${alphaContention.toFixed(3)}) -> ${tipLamports} lamports`);
            }
            
            // Re-build the bundle with the tightly fitted CU limit!
            built = await this.buildBundleFromInstructions(parsed as TransactionInstruction[], tipLamports, tipAccount, opts.extraSigners, optimizedLimit);
          }
        }
      }
      
      if (simRes && (simRes.result?.value?.summary === "failed" || simRes.error)) {
        const errorLogs = simRes.error 
          ? JSON.stringify(simRes.error)
          : JSON.stringify(simRes.result.value.transactionResults);
        
        log.error("Pre-flight bundle simulation failed! Aborting Jito submission.", { 
          logs: errorLogs 
        });

        // Track the exact simulation failure locally so the AI Agent instantly picks it up!
        const simBundleId = `sim_bundle_${Math.random().toString(36).substring(2, 11)}`;
        this.lifecycle!.track({
          bundleId: simBundleId,
          signatures: built.signatures,
          tipLamports: tipLamports,
          tipAccount: tipAccount,
          submittedAt: Date.now(),
          blockhash: built.blockhash,
          lastValidBlockHeight: built.lastValidBlockHeight
        }, ctx.attempt, currentSlot);
        
        this.lifecycle!.fail(simBundleId, {
          type: "simulation_failed",
          evidence: { logs: errorLogs },
          detectedAtSlot: currentSlot,
          ts: new Date().toISOString()
        });
        
        return {
           bundleId: simBundleId,
           landed: false,
           lifecycle: this.lifecycle!.get(simBundleId)!,
           error: errorLogs
        };
      }

      result = await submitBundle(built);
      this.lifecycle!.track(result, ctx.attempt, currentSlot);

      // If Jito marks the bundle Invalid early (no auth token / deprioritised),
      // fall back to a direct sendTransaction so the tx still lands via normal TPU.
      this.jitoInvalidFallback(result.bundleId, built).catch((err) =>
        log.debug("jito-invalid RPC fallback error", { err: String(err) })
      );
    }

    // Wait for confirmation on Yellowstone stream
    const landed = (opts.simulateFault && ctx.attempt === 1)
      ? false
      : await this.awaitConfirmation(result.bundleId);
    const lifecycleEntry = this.lifecycle!.get(result.bundleId) || ({
      bundle_id: result.bundleId,
      signatures: result.signatures,
      tip_lamports: tipLamports,
      tip_account: tipAccount,
      attempt: ctx.attempt,
      stages: {},
      deltas_ms: {},
      failure: null,
      confirmed_via: null,
    } as LifecycleEntry);

    if (landed) {
      return {
        bundleId: result.bundleId,
        landed: true,
        signature: result.signatures[0],
        slot: lifecycleEntry.stages.processed?.slot,
        lifecycle: lifecycleEntry,
      };
    }

    // Handle failure path
    const failure = (opts.simulateFault && ctx.attempt === 1)
      ? this.getSimulatedFailure(opts.simulateFault, result.bundleId, currentSlot, targetLeaderSlot, tipLamports)
      : this.classifyTimeout(result.bundleId, currentSlot, targetLeaderSlot, tipLamports, tf.p50, congestion);

    this.lifecycle!.fail(result.bundleId, failure);

    if (ctx.attempt >= this.maxAttempts) {
      return {
        bundleId: result.bundleId,
        landed: false,
        lifecycle: this.lifecycle!.get(result.bundleId) || lifecycleEntry,
        error: `Max attempts (${this.maxAttempts}) exceeded without landing. Last failure: ${failure.type}`,
      };
    }

    // Prepare AI agent context
    const agentInput: AgentInput = {
      event: "bundle_failed",
      failure,
      bundle: {
        attempt: ctx.attempt,
        tip_lamports: tipLamports,
        tip_account: result.tipAccount,
        submitted_slot: currentSlot,
        target_leader_slot: targetLeaderSlot,
      },
      network: {
        current_slot: win?.currentSlot ?? currentSlot,
        slot_skip_rate_64: congestion.skipRate,
        processed_to_confirmed_ms_p50: congestion.p2cMsP50,
        tip_floor: tf,
        next_jito_leader_slot: win?.nextJitoLeaderSlot ?? targetLeaderSlot,
        slots_until_jito_leader: win?.slotsUntilJitoLeader ?? 0,
        remaining_tip_budget_lamports: opts.remainingTipBudgetLamports !== undefined
          ? opts.remainingTipBudgetLamports
          : undefined,
      },
      history: ctx.history,
    };

    // Add presigned flag in prompt context (agent reads free context if needed)
    // We can run the AI agent
    const decision = await this.agent.evaluate(agentInput);
    log.info("Agent retry decision received", {
      action: decision.action,
      rootCause: decision.diagnosis,
      confidence: decision.confidence,
    });

    const nextHistory = [
      ...ctx.history,
      { attempt: ctx.attempt, outcome: failure.type },
    ];

    if (decision.action === "ABORT") {
      db.recordOutcome(result.bundleId, `aborted — ${decision.diagnosis}`);
      return {
        bundleId: result.bundleId,
        landed: false,
        lifecycle: this.lifecycle!.get(result.bundleId) || lifecycleEntry,
        error: `Aborted by AI Agent: ${decision.diagnosis}`,
      };
    }

    if (decision.action === "HOLD") {
      db.recordOutcome(result.bundleId, "held — retry on next window");
      return this.runOneSubmitAttempt(
        { attempt: ctx.attempt + 1, history: nextHistory },
        parsed,
        isPresigned,
        opts,
        {
          newTipLamports: decision.params?.new_tip_lamports,
          submitAtSlot: decision.params?.submit_at_slot
        }
      );
    }

    // action === "RETRY"
    if (decision.params?.refresh_blockhash && isPresigned) {
      if (!this.canReSign(parsed as VersionedTransaction | Transaction)) {
        const abortMsg = "AI Agent requested refresh_blockhash for a pre-signed transaction. Re-signing requires the private key.";
        db.recordOutcome(result.bundleId, `aborted — ${abortMsg}`);
        return {
          bundleId: result.bundleId,
          landed: false,
          lifecycle: this.lifecycle!.get(result.bundleId) || lifecycleEntry,
          error: abortMsg,
        };
      }
    }

    const outcome = await this.runOneRetry(
      { attempt: ctx.attempt + 1, history: nextHistory },
      parsed,
      isPresigned,
      opts,
      decision.params?.refresh_blockhash || false,
      decision.params?.new_tip_lamports || tipLamports,
      decision.params?.submit_at_slot
    );

    db.recordOutcome(result.bundleId, outcome.landed ? `landed @ slot ${outcome.slot}` : `failed retry: ${outcome.error}`);
    return outcome;
  }

  private canReSign(parsed: VersionedTransaction | Transaction): boolean {
    if (!this.sdkWallet) return false;
    if (parsed instanceof VersionedTransaction) {
      const numSigners = parsed.message.header.numRequiredSignatures;
      if (numSigners === 1) {
        const signerKey = parsed.message.staticAccountKeys[0];
        return !!(signerKey && signerKey.equals(this.sdkWallet.publicKey));
      }
      return false;
    } else if (parsed instanceof Transaction) {
      const signers = parsed.signatures.map((s) => s.publicKey);
      if (signers.length === 1 && signers[0]) {
        return signers[0].equals(this.sdkWallet.publicKey);
      }
      return false;
    }
    return false;
  }

  private getSimulatedFailure(
    faultType: string,
    bundleId: string,
    currentSlot: number,
    targetLeaderSlot: number,
    tipLamports: number
  ): FailureRecord {
    const ts = new Date().toISOString();
    const detectedAtSlot = currentSlot;
    switch (faultType) {
      case "blockhash_expired":
        return {
          type: "blockhash_expired",
          detectedAtSlot,
          ts,
          evidence: {
            reason: "Blockhash expired: transaction was not processed before the last valid block height",
            lastValidBlockHeight: currentSlot - 10,
            currentBlockHeight: currentSlot + 5,
          },
        };
      case "fee_too_low":
        return {
          type: "fee_too_low",
          detectedAtSlot,
          ts,
          evidence: {
            reason: "Jito bundle dropped due to insufficient tip auction bid compared to competitive floors",
            tipLamports,
            floorP50: tipLamports * 5,
          },
        };
      case "compute_exceeded":
        return {
          type: "compute_exceeded",
          detectedAtSlot,
          ts,
          evidence: {
            reason: "Transaction execution exceeded maximum compute units allocated",
            simulationError: "Exceeded compute budget limit of 1400000 CUs",
          },
        };
      case "leader_skip":
        return {
          type: "bundle_dropped_leader_skip",
          detectedAtSlot,
          ts,
          evidence: {
            reason: "Leader skipped scheduled slots",
            leaderSlot: targetLeaderSlot,
          },
        };
      case "slippage_exceeded":
        return {
          type: "simulation_failed",
          detectedAtSlot,
          ts,
          evidence: {
            reason: "Slippage tolerance exceeded",
            simulationError: "custom program error: 0x1772 (SlippageToleranceExceeded)",
          },
        };
      default:
        return {
          type: "simulation_failed",
          detectedAtSlot,
          ts,
          evidence: {
            reason: "Unknown simulated fault",
          },
        };
    }
  }

  private async runOneRetry(
    ctx: AttemptCtx,
    parsed: VersionedTransaction | Transaction | TransactionInstruction[] | BundleTransaction[],
    isPresigned: boolean,
    opts: AutoLandSubmitOptions,
    refreshBlockhash: boolean,
    newTipLamports: number,
    submitAtSlot?: number
  ): Promise<AutoLandResult> {
    let nextParsed = parsed;
    if (refreshBlockhash) {
      if (!isPresigned) {
        log.info("Refreshing blockhash for instructions retry...");
        // Re-sign occurs during building phase when we call buildBundleFromInstructions with no blockhash (will fetch fresh)
        nextParsed = parsed;
      } else {
        log.info("Refreshing blockhash and re-signing pre-signed transaction...");
        const bh = await fetchConfirmedBlockhash(this.sdkConnection);
        if (parsed instanceof VersionedTransaction) {
          (parsed.message as any).recentBlockhash = bh.blockhash;
          parsed.signatures = parsed.signatures.map(() => new Uint8Array(64));
          parsed.sign([this.sdkWallet]);
        } else if (parsed instanceof Transaction) {
          parsed.recentBlockhash = bh.blockhash;
          parsed.signatures = [];
          parsed.sign(this.sdkWallet);
        }
        nextParsed = parsed;
      }
    }
    return this.runOneSubmitAttempt(ctx, nextParsed, isPresigned, opts, { newTipLamports, submitAtSlot });
  }

  private async buildBundleFromMultipleTxs(
    bundleTxs: BundleTransaction[],
    tipLamports: number,
    tipAccount: string,
    cuLimits?: number[]
  ): Promise<BuiltBundle> {
    const bh = await fetchConfirmedBlockhash(this.sdkConnection);
    const tipPubkey = new PublicKey(tipAccount);

    const encodedTxs: string[] = [];
    const signatures: string[] = [];

    // Compile and sign all bundle transactions sequentially
    for (let i = 0; i < bundleTxs.length; i++) {
      const bundleTx = bundleTxs[i];
      
      // Filter out existing compute limits
      const ixs = bundleTx.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId));
      
      // Inject specific or default massive CU limit for this exact tx
      const limit = cuLimits && cuLimits[i] ? cuLimits[i] : 1_400_000;
      ixs.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: limit }));

      const msg = new TransactionMessage({
        payerKey: this.sdkWallet.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(msg);
      
      const signers = [this.sdkWallet];
      if (bundleTx.signers) {
        signers.push(...bundleTx.signers);
      }
      tx.sign(signers);

      encodedTxs.push(Buffer.from(tx.serialize()).toString("base64"));
      signatures.push(bs58.encode(tx.signatures[0]!));
    }

    // Append tip transaction at the end of the bundle
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.sdkWallet.publicKey,
      toPubkey: tipPubkey,
      lamports: tipLamports,
    });

    const tipMsg = new TransactionMessage({
      payerKey: this.sdkWallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: [tipIx],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMsg);
    tipTx.sign([this.sdkWallet]);

    encodedTxs.push(Buffer.from(tipTx.serialize()).toString("base64"));
    signatures.push(bs58.encode(tipTx.signatures[0]!));

    const slot = await this.sdkConnection.getSlot("confirmed");

    return {
      encodedTxs,
      signatures,
      tipAccount,
      tipLamports,
      blockhash: bh.blockhash,
      lastValidBlockHeight: slot + 150, // estimated
      fetchedAtSlot: slot,
    };
  }

  private async buildBundleFromTx(
    tx: VersionedTransaction | Transaction,
    tipLamports: number,
    tipAccount: string
  ): Promise<BuiltBundle> {
    const blockhash = tx instanceof VersionedTransaction
      ? tx.message.recentBlockhash
      : tx.recentBlockhash;

    if (!blockhash) {
      throw new Error("Transaction is missing recentBlockhash");
    }

    if (!this.sdkWallet) {
      throw new Error("WALLET_SECRET_KEY is required to sign Jito tip transactions.");
    }

    // Build the tip transfer transaction
    const tipPubkey = new PublicKey(tipAccount);
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.sdkWallet.publicKey,
      toPubkey: tipPubkey,
      lamports: tipLamports,
    });

    const tipMsg = new TransactionMessage({
      payerKey: this.sdkWallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipIx],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMsg);
    tipTx.sign([this.sdkWallet]);

    const devTxBase64 = Buffer.from(tx.serialize()).toString("base64");
    const tipTxBase64 = Buffer.from(tipTx.serialize()).toString("base64");

    const devSig = tx instanceof VersionedTransaction
      ? bs58.encode(tx.signatures[0]!)
      : bs58.encode(tx.signature!);

    const tipSig = bs58.encode(tipTx.signatures[0]!);

    // Estimate validity slot based on current slot
    const slot = await this.sdkConnection.getSlot("confirmed");

    return {
      encodedTxs: [devTxBase64, tipTxBase64],
      signatures: [devSig, tipSig],
      tipAccount,
      tipLamports,
      blockhash,
      lastValidBlockHeight: slot + 150, // estimated
      fetchedAtSlot: slot,
    };
  }

  private async buildBundleFromInstructions(
    instructions: TransactionInstruction[],
    tipLamports: number,
    tipAccount: string,
    extraSigners?: Keypair[],
    cuLimit: number = 1_400_000
  ): Promise<BuiltBundle> {
    const bh = await fetchConfirmedBlockhash(this.sdkConnection);
    const tipPubkey = new PublicKey(tipAccount);

    // Strip existing compute budget instructions
    const ixs = instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId));
    
    // Inject dynamic or default massive CU limit
    ixs.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));

    ixs.push(
      SystemProgram.transfer({
        fromPubkey: this.sdkWallet.publicKey,
        toPubkey: tipPubkey,
        lamports: tipLamports,
      })
    );

    const msg = new TransactionMessage({
      payerKey: this.sdkWallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    const signers = [this.sdkWallet];
    if (extraSigners) {
      signers.push(...extraSigners);
    }
    tx.sign(signers);

    const sig = bs58.encode(tx.signatures[0]!);
    const txBase64 = Buffer.from(tx.serialize()).toString("base64");

    return {
      encodedTxs: [txBase64],
      signatures: [sig],
      tipAccount,
      tipLamports,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
      fetchedAtSlot: bh.fetchedAtSlot,
    };
  }

  /**
   * Polls Jito's inflight status for 8 s. If the bundle is already "Invalid"
   * (block engine rejected it — usually lack of auth token), we fall back to a
   * direct sendTransaction via our RPC so the transaction still lands via the
   * normal TPU path. The Yellowstone stream will confirm it once it processes.
   */
  private async jitoInvalidFallback(bundleId: string, built: BuiltBundle): Promise<void> {
    const POLL_INTERVAL_MS = 2_000;
    const GIVE_UP_MS = 8_000;
    const deadline = Date.now() + GIVE_UP_MS;

    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);
      try {
        const statuses = await this.jito.getInflightBundleStatuses([bundleId]);
        const s = statuses.find((x) => x.bundle_id === bundleId);
        if (s?.status === "Invalid") {
          log.warn("bundle marked Invalid by Jito; RPC fallback is disabled.", { bundleId });
          // for (const encodedTx of built.encodedTxs) {
          //   const buf = Buffer.from(encodedTx, "base64");
          //   const tx = VersionedTransaction.deserialize(buf);
          //   await this.sdkConnection.sendRawTransaction(tx.serialize(), {
          //     skipPreflight: false,
          //     maxRetries: 3,
          //   }).then((sig) => log.info("RPC fallback tx sent", { sig }))
          //     .catch((err) => log.debug("RPC fallback tx send error", { err: String(err) }));
          // }
          return;
        }
        if (s?.status === "Landed" || s?.status === "Pending") return;
      } catch (err) {
        log.debug("inflight status check failed in fallback", { err: String(err) });
      }
    }
  }

  private async pickTipAccount(): Promise<string> {
    const accounts = await this.jito.getTipAccounts();
    return accounts[Math.floor(Math.random() * accounts.length)]!;
  }

  private async simulateBundleLocally(encodedTxs: string[]): Promise<any> {
    const res = await fetch(this.sdkConnection.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateBundle",
        params: [{ encodedTransactions: encodedTxs }]
      })
    });
    return res.json();
  }

  private clampTip(lamports: number, dynamicFloor: number): number {
    const absoluteFloor = Math.max(dynamicFloor, config.tips.floorLamports);
    return Math.min(config.tips.ceilingLamports, Math.max(absoluteFloor, Math.round(lamports)));
  }

  private classifyTimeout(
    bundleId: string,
    currentSlot: number,
    targetLeaderSlot: number,
    tipLamports: number,
    tipFloorP50: number,
    congestion: CongestionSnapshot
  ): FailureRecord {
    return classifyFailure({
      bundleId,
      currentSlot,
      neverProcessed: true,
      targetLeaderSlot,
      tipLamports,
      tipFloorP50,
      congestion,
    });
  }

  private async awaitConfirmation(bundleId: string): Promise<boolean> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    const entry = this.lifecycle!.get(bundleId);
    const sigs = entry?.signatures ?? [];
    let lastPollAt = 0;

    while (Date.now() < deadline) {
      const current = this.lifecycle!.get(bundleId);
      if (current?.stages.confirmed) return true;
      if (current?.failure) return false;

      const now = Date.now();
      if (now - lastPollAt >= 3_000) {
        lastPollAt = now;

        // 1. Check Jito Bundle Status API
        try {
          const statuses = await this.jito.getBundleStatuses([bundleId]);
          const s = statuses.find((x) => x.bundle_id === bundleId);
          if (s && (s.confirmation_status === "confirmed" || s.confirmation_status === "finalized")) {
            log.info("Reconciled bundle confirmation via Jito API", { bundleId, slot: s.slot });
            this.lifecycle!.reconcile(bundleId, s.confirmation_status, s.slot);
            return true;
          }
        } catch { /* ignore */ }

        // 2. Check Solana RPC Signature Statuses (for RPC TPU fallbacks)
        if (sigs.length > 0) {
          try {
            const resp = await this.sdkConnection.getSignatureStatuses(sigs, { searchTransactionHistory: true });
            if (resp?.value.some((s) => s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"))) {
              const slot = resp.value.find((s) => s)?.slot ?? 0;
              log.info("Reconciled bundle confirmation via RPC", { bundleId, slot });
              this.lifecycle!.reconcile(bundleId, "confirmed", slot);
              return true;
            }
          } catch { /* ignore */ }
        }
      }

      await this.sleep(500);
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
