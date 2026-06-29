import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Blockhash,
  Connection,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";

import { jitoClient, type JitoClient } from "./client.js";
import { logger } from "../common/logger.js";
import type { LifecycleTracker, LifecycleEntry, FailureRecord } from "../recovery/tracker.js";
import type { Commitment, StreamManager } from "../monitor/connection.js";
import { config } from "../config.js";
import { type CongestionOracle, type LeaderWindowDetector, type LeaderWindow, type CongestionSnapshot } from "../monitor/telemetry.js";
import { classifyFailure } from "../recovery/classifier.js";
import { type TipFloorService, computeTip } from "./fees.js";
import { Agent } from "../recovery/advisor.js";
import { db } from "../recovery/db.js";

const logBuilder = logger("builder");
const logSubmitter = logger("submitter");
const logStatus = logger("status");
const log = logger("sdk");

const MAX_TXS_PER_BUNDLE = 5;

export interface BlockhashInfo {
  blockhash: Blockhash;
  lastValidBlockHeight: number;
  fetchedAtSlot: number;
}

export interface BundlePlan {
  transactions: TransactionInstruction[][];
  tipLamports: number;
  tipAccount?: string;
  blockhash?: BlockhashInfo;
}

export interface BuiltBundle {
  encodedTxs: string[];
  signatures: string[];
  tipAccount: string;
  tipLamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAtSlot: number;
}

let _tipAccounts: string[] | undefined;
async function getTipAccounts(): Promise<string[]> {
  if (_tipAccounts && _tipAccounts.length > 0) return _tipAccounts;
  _tipAccounts = await jitoClient().getTipAccounts();
  return _tipAccounts;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export async function fetchConfirmedBlockhash(conn: Connection): Promise<BlockhashInfo> {
  const [{ blockhash, lastValidBlockHeight }, slot] = await Promise.all([
    conn.getLatestBlockhash("confirmed"),
    conn.getSlot("confirmed"),
  ]);
  return { blockhash, lastValidBlockHeight, fetchedAtSlot: slot };
}

export async function buildBundle(plan: BundlePlan, payer: Keypair, conn: Connection): Promise<BuiltBundle> {
  if (plan.transactions.length === 0) {
    throw new Error("bundle must contain at least one transaction");
  }
  if (plan.transactions.length > MAX_TXS_PER_BUNDLE) {
    throw new Error(`bundle exceeds ${MAX_TXS_PER_BUNDLE} transactions`);
  }

  const bh = plan.blockhash ?? (await fetchConfirmedBlockhash(conn));
  const tipAccount = plan.tipAccount ?? pickRandom(await getTipAccounts());
  const tipPubkey = new PublicKey(tipAccount);

  const groups = plan.transactions.map((ixs) => [...ixs]);
  const lastGroup = groups[groups.length - 1]!;
  lastGroup.push(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tipPubkey,
      lamports: plan.tipLamports,
    }),
  );

  const encodedTxs: string[] = [];
  const signatures: string[] = [];

  for (const ixs of groups) {
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);

    const sig = tx.signatures[0];
    if (!sig) throw new Error("transaction missing signature after signing");
    signatures.push(bs58.encode(sig));
    encodedTxs.push(Buffer.from(tx.serialize()).toString("base64"));
  }

  logBuilder.info("bundle built", {
    txCount: encodedTxs.length,
    tipLamports: plan.tipLamports,
    tipAccount,
    blockhash: bh.blockhash,
  });

  return {
    encodedTxs,
    signatures,
    tipAccount,
    tipLamports: plan.tipLamports,
    blockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    fetchedAtSlot: bh.fetchedAtSlot,
  };
}

export interface SubmitResult {
  bundleId: string;
  signatures: string[];
  tipLamports: number;
  tipAccount: string;
  submittedAt: number;
  blockhash: string;
  lastValidBlockHeight: number;
}

export async function submitBundle(built: BuiltBundle): Promise<SubmitResult> {
  const bundleId = await jitoClient().sendBundle(built.encodedTxs, "base64");
  const submittedAt = Date.now();
  logSubmitter.info("bundle submitted", {
    bundleId,
    signatures: built.signatures,
    tipLamports: built.tipLamports,
  });
  return {
    bundleId,
    signatures: built.signatures,
    tipLamports: built.tipLamports,
    tipAccount: built.tipAccount,
    submittedAt,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
  };
}

export class StatusReconciler {
  constructor(
    private readonly tracker: LifecycleTracker,
    private readonly jito = jitoClient(),
  ) {}

  async poll(bundleId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    let last = "Pending";

    while (Date.now() < deadline) {
      try {
        const [inflight] = await this.jito.getInflightBundleStatuses([bundleId]);
        if (inflight) {
          last = inflight.status;
          if (inflight.status === "Landed") {
            await this.reconcileFinal(bundleId);
            return last;
          }
          if (inflight.status === "Failed" || inflight.status === "Invalid") {
            return last;
          }
        }
      } catch (err) {
        logStatus.warn("inflight poll error", { bundleId, err: String(err) });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return last;
  }

  private async reconcileFinal(bundleId: string): Promise<void> {
    try {
      const [status] = await this.jito.getBundleStatuses([bundleId]);
      if (!status) return;
      const commitment = mapConfirmation(status.confirmation_status);
      if (commitment) {
        this.tracker.reconcile(bundleId, commitment, status.slot);
        logStatus.debug("reconciled via status api", { bundleId, commitment, slot: status.slot });
      }
    } catch (err) {
      logStatus.warn("getBundleStatuses error", { bundleId, err: String(err) });
    }
  }
}

function mapConfirmation(c: string | null): Commitment | undefined {
  if (c === "processed" || c === "confirmed" || c === "finalized") return c;
  return undefined;
}

export interface AutoLandSubmitOptions {
  urgency?: "normal" | "high";
  customTipLamports?: number;
  simulateFault?: "blockhash_expired" | "fee_too_low" | "compute_exceeded" | "leader_skip" | "slippage_exceeded";
  remainingTipBudgetLamports?: number;
  extraSigners?: Keypair[];
  expectedProfitLamports?: number;
  maxProfitSharePct?: number;
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

export interface DispatchContext {
  sdkConnection: Connection;
  sdkWallet: Keypair;
  submitEnabled: boolean;
  maxAttempts: number;
  confirmTimeoutMs: number;
  submitCooldownMs: number;
  getStream: () => StreamManager | undefined;
  getOracle: () => CongestionOracle | undefined;
  getLeader: () => LeaderWindowDetector | undefined;
  getLifecycle: () => LifecycleTracker | undefined;
  tipFloor: TipFloorService;
  agent: Agent;
  jito: JitoClient;
  emit?: (event: string, ...args: any[]) => boolean;
}

export class BundleDispatcher {
  constructor(private readonly ctx: DispatchContext) {}

  async submit(
    txInput: VersionedTransaction | Transaction | TransactionInstruction[] | string | Buffer | BundleTransaction[],
    opts: AutoLandSubmitOptions = {}
  ): Promise<AutoLandResult> {
    const parsed = this.parseTransactionInput(txInput);

    const stream = this.ctx.getStream();
    if (stream) {
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
        stream.trackAccounts(keys);
      }
    }

    const isPresigned = !(Array.isArray(parsed));

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
    const tf = await this.ctx.tipFloor.get();
    const oracle = this.ctx.getOracle();
    const congestion = oracle ? oracle.snapshot() : { windowSize: 0, skipRate: 0, p2cMsP50: 0, p2cMsP95: 0, congestionMultiplier: 1.0, sampleCount: 0 };

    const tipAccount = await this.pickTipAccount();

    const stream = this.ctx.getStream();
    const alphaContention = stream?.contentionTracker?.getAlphaContention() ?? 1.0;
    const maxCompetitorTipPerCU = stream?.competitorTracker?.getMaxTipPerCU() ?? 0;

    let tipLamports = override?.newTipLamports != null
      ? this.clampTip(override.newTipLamports, tf.p25)
      : opts.customTipLamports != null
        ? opts.customTipLamports
        : computeTip({
          tipFloor: tf,
          congestionMultiplier: congestion.congestionMultiplier,
          alphaContention,
          maxCompetitorTipPerCU,
          cuScalar: 1.0,
          urgency: opts.urgency ?? "normal",
          expectedProfitLamports: opts.expectedProfitLamports,
          maxProfitSharePct: opts.maxProfitSharePct
        }).lamports;

    let win: LeaderWindow | undefined;
    const leader = this.ctx.getLeader();
    if (leader) {
      try {
        win = await leader.window();
      } catch (err) {
        log.debug("Leader window fetch failed in submit, using slot fallback", { err: String(err) });
      }
    }

    const currentSlot = win?.currentSlot ?? (await this.ctx.sdkConnection.getSlot("confirmed"));
    const targetLeaderSlot = win?.nextJitoLeaderSlot ?? (currentSlot + 4);

    let built: BuiltBundle;

    const isBundleTransactionArray = (arr: any[]): arr is BundleTransaction[] => {
      return arr.length > 0 && 'instructions' in arr[0];
    };

    if (Array.isArray(parsed)) {
      if (!this.ctx.sdkWallet) {
        throw new Error("WALLET_SECRET_KEY is required to sign raw instructions.");
      }

      if (isBundleTransactionArray(parsed)) {
        built = await this.buildBundleFromMultipleTxs(parsed, tipLamports, tipAccount);
      } else {
        built = await this.buildBundleFromInstructions(parsed as TransactionInstruction[], tipLamports, tipAccount, opts.extraSigners);
      }
    } else {
      built = await this.buildBundleFromTx(parsed, tipLamports, tipAccount);
    }

    if (!this.ctx.submitEnabled) {
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

    let result: any;
    let submitError: any = null;
    const lifecycle = this.ctx.getLifecycle();
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
      if (lifecycle) lifecycle.track(result, ctx.attempt, currentSlot);
    } else {

      if (override?.submitAtSlot) {
        log.info(`Agent instructed to pause execution until slot ${override.submitAtSlot}. Current slot: ${currentSlot}`);
        let nowSlot = currentSlot;
        while (nowSlot < override.submitAtSlot) {
          await new Promise(r => setTimeout(r, 100));
          if (leader) {
            const w = await leader.window().catch((err) => {
              log.warn(`[WARN] Jito API error while waiting for slot: ${err.message || err}`);
              return null;
            });
            nowSlot = w?.currentSlot ?? nowSlot;
          }
        }
      }

      log.info(`Awaiting Jito inSubmitWindow before firing bundle...`);
      let isWindowOpen = false;
      let finalWin = win;
      while (!isWindowOpen && !submitError) {
        if (leader) {
          finalWin = await leader.window().catch((err) => {
            log.error(`[ERROR] Jito API poll failed (e.g. 429 Rate Limit): ${err.message || err}`);
            submitError = err;
            return undefined;
          });
        } else {
          isWindowOpen = true;
        }

        if (submitError) {
          log.warn("Breaking Jito window wait due to API error (429/timeout)");
          break;
        }

        if (finalWin?.inSubmitWindow) {
          isWindowOpen = true;
        } else if (leader) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      if (!submitError) {
        log.info(`inSubmitWindow is true! Firing bundle at slot ${finalWin?.currentSlot}`);

        log.info(`Running pre-flight bundle simulation locally...`);
        let simRes;
        try {
          simRes = await this.simulateBundleLocally(built.encodedTxs);
        } catch (err) {
          log.warn("Local simulateBundle request failed, proceeding anyway", { err: String(err) });
        }

        if (simRes && simRes.result?.value?.summary === "succeeded" && Array.isArray(parsed)) {
          const results = simRes.result.value.transactionResults;

          if (isBundleTransactionArray(parsed)) {
            let modified = false;
            const optimizedLimits: number[] = [];

            for (let i = 0; i < parsed.length; i++) {
              const txResult = results[i];
              let unitsConsumed = txResult?.unitsConsumed;
              if (unitsConsumed && unitsConsumed > 0) {
                optimizedLimits.push(Math.ceil(unitsConsumed * 1.10));
                modified = true;
              } else {
                optimizedLimits.push(1_400_000);
              }
            }

            if (modified) {
              log.info(`[OPTIMIZATION] Dynamic CU sizing for multi-tx bundle: ${optimizedLimits.join(', ')}`);

              if (opts.customTipLamports == null && override?.newTipLamports == null) {
                const totalCUs = optimizedLimits.reduce((a, b) => a + b, 0);
                const cuScalar = Math.max(0.1, totalCUs / 50_000);

                tipLamports = computeTip({
                  tipFloor: tf,
                  congestionMultiplier: congestion.congestionMultiplier,
                  alphaContention,
                  maxCompetitorTipPerCU,
                  cuScalar,
                  urgency: opts.urgency ?? "normal",
                  expectedProfitLamports: opts.expectedProfitLamports,
                  maxProfitSharePct: opts.maxProfitSharePct
                }).lamports;
                log.info(`[OPTIMIZATION] Dynamic tip recalculation (CU Scalar: ${cuScalar.toFixed(3)}, Alpha: ${alphaContention.toFixed(3)}, Competitor Tip/CU: ${maxCompetitorTipPerCU.toFixed(4)}) -> ${tipLamports} lamports`);
              }

              built = await this.buildBundleFromMultipleTxs(parsed, tipLamports, tipAccount, optimizedLimits);
            }
          } else {
            const mainTxResult = results.length > 1 ? results[1] : results[0];

            let unitsConsumed = mainTxResult?.unitsConsumed;
            if (!unitsConsumed && results[0]?.unitsConsumed) {
              unitsConsumed = results[0].unitsConsumed;
            }

            if (unitsConsumed && unitsConsumed > 0) {
              const optimizedLimit = Math.ceil(unitsConsumed * 1.10);
              log.info(`[OPTIMIZATION] Dynamic CU sizing: Simulation consumed ${unitsConsumed} CU. Shrinking bundle limit to ${optimizedLimit} CU.`);

              if (opts.customTipLamports == null && override?.newTipLamports == null) {
                const cuScalar = Math.max(0.1, optimizedLimit / 50_000);
                tipLamports = computeTip({
                  tipFloor: tf,
                  congestionMultiplier: congestion.congestionMultiplier,
                  alphaContention,
                  maxCompetitorTipPerCU,
                  cuScalar,
                  urgency: opts.urgency ?? "normal",
                  expectedProfitLamports: opts.expectedProfitLamports,
                  maxProfitSharePct: opts.maxProfitSharePct
                }).lamports;
                log.info(`[OPTIMIZATION] Dynamic tip recalculation (CU Scalar: ${cuScalar.toFixed(3)}, Alpha: ${alphaContention.toFixed(3)}, Competitor Tip/CU: ${maxCompetitorTipPerCU.toFixed(4)}) -> ${tipLamports} lamports`);
              }

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

          const simBundleId = `sim_bundle_${Math.random().toString(36).substring(2, 11)}`;
          if (lifecycle) {
            lifecycle.track({
              bundleId: simBundleId,
              signatures: built.signatures,
              tipLamports: tipLamports,
              tipAccount: tipAccount,
              submittedAt: Date.now(),
              blockhash: built.blockhash,
              lastValidBlockHeight: built.lastValidBlockHeight
            }, ctx.attempt, currentSlot);

            lifecycle.fail(simBundleId, {
              type: "simulation_failed",
              evidence: { logs: errorLogs },
              detectedAtSlot: currentSlot,
              ts: new Date().toISOString()
            });
          }

          if (this.ctx.emit) {
            this.ctx.emit("simulation_failed", {
              bundleId: simBundleId,
              signatures: built.signatures,
              attempt: ctx.attempt,
              error: errorLogs
            });
          }

          return {
            bundleId: simBundleId,
            landed: false,
            lifecycle: lifecycle ? lifecycle.get(simBundleId)! : {
              bundle_id: simBundleId,
              signatures: built.signatures,
              tip_lamports: tipLamports,
              tip_account: tipAccount,
              attempt: ctx.attempt,
              stages: {},
              deltas_ms: {},
              failure: null,
              confirmed_via: null,
            },
            error: errorLogs
          };
        }

        try {
          result = await submitBundle(built);
          if (lifecycle) lifecycle.track(result, ctx.attempt, currentSlot);

          if (this.ctx.emit) {
            this.ctx.emit("bundle_submitted", {
              attempt: ctx.attempt,
              bundleId: result.bundleId,
              signatures: result.signatures,
              tipLamports: result.tipLamports,
              tipAccount: result.tipAccount,
              slot: currentSlot
            });
          }

          this.jitoInvalidFallback(result.bundleId, built).catch((err) =>
            log.debug("Jito-invalid RPC fallback error", { err: String(err) })
          );
        } catch (err) {
          log.error("Jito submission failed, capturing error to trigger AI fallback", { err: String(err) });
          submitError = err;
        }
      }

      if (submitError) {
        const generatedId = `err_bundle_${Math.random().toString(36).substring(2, 11)}`;
        result = {
          bundleId: generatedId,
          signatures: built.signatures,
          tipLamports: built.tipLamports,
          tipAccount: built.tipAccount,
          submittedAt: Date.now(),
          blockhash: built.blockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
        };
        if (lifecycle) lifecycle.track(result, ctx.attempt, currentSlot);
      }
    }

    const landed = ((opts.simulateFault && ctx.attempt === 1) || submitError)
      ? false
      : await this.awaitConfirmation(result.bundleId);
    const lifecycleEntry = (lifecycle ? lifecycle.get(result.bundleId) : null) || ({
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

    const failure = submitError
      ? {
        type: "jito_api_error" as const,
        detectedAtSlot: currentSlot,
        ts: new Date().toISOString(),
        evidence: {
          reason: "Jito Block Engine API or submission failed (e.g. rate limit, HTTP 429)",
          error: String(submitError),
        },
      }
      : (opts.simulateFault && ctx.attempt === 1)
        ? this.getSimulatedFailure(opts.simulateFault, result.bundleId, currentSlot, targetLeaderSlot, tipLamports)
        : this.classifyTimeout(result.bundleId, currentSlot, targetLeaderSlot, tipLamports, tf.p50, congestion);

    if (lifecycle) lifecycle.fail(result.bundleId, failure);

    const agentInput: any = {
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

    const decision = await this.ctx.agent.evaluate(agentInput);
    log.info("Agent retry decision received", {
      action: decision.action,
      rootCause: decision.diagnosis,
      confidence: decision.confidence,
    });

    if (this.ctx.emit) {
      this.ctx.emit("ai_decision", {
        bundleId: result.bundleId,
        attempt: ctx.attempt,
        input: agentInput,
        decision: decision
      });
    }

    const nextHistory = [
      ...ctx.history,
      { attempt: ctx.attempt, outcome: failure.type },
    ];

    if ((decision.action === "RETRY" || decision.action === "HOLD") && ctx.attempt >= this.ctx.maxAttempts) {
      log.warn(`AI Agent decided to ${decision.action}, but max attempts (${this.ctx.maxAttempts}) has been reached. Forcing ABORT.`);
      db.recordOutcome(result.bundleId, `aborted — max attempts reached`);
      return {
        bundleId: result.bundleId,
        landed: false,
        lifecycle: (lifecycle ? lifecycle.get(result.bundleId) : null) || lifecycleEntry,
        error: `Max attempts (${this.ctx.maxAttempts}) reached without landing. Forced abort on AI retry/hold decision.`,
      };
    }

    if (decision.action === "ABORT") {
      db.recordOutcome(result.bundleId, `aborted — ${decision.diagnosis}`);
      return {
        bundleId: result.bundleId,
        landed: false,
        lifecycle: (lifecycle ? lifecycle.get(result.bundleId) : null) || lifecycleEntry,
        error: `Aborted by AI Agent: ${decision.diagnosis}`,
      };
    }

    if (decision.action === "FALLBACK_RPC") {
      db.recordOutcome(result.bundleId, `fallback RPC initiated — ${decision.diagnosis}`);
      log.info(`AI Agent initiated public RPC fallback! Diagnosis: ${decision.diagnosis}`);
      try {
        if (lifecycle) {
          lifecycle.prepareForFallback(result.bundleId);
        }
        let fallbackBuilt = built;
        if (!isPresigned || this.canReSign(parsed as VersionedTransaction | Transaction)) {
          log.info("Refreshing blockhash for public RPC fallback transactions...");
          if (Array.isArray(parsed)) {
            if (isBundleTransactionArray(parsed)) {
              fallbackBuilt = await this.buildBundleFromMultipleTxs(parsed, tipLamports, tipAccount);
            } else {
              fallbackBuilt = await this.buildBundleFromInstructions(parsed as TransactionInstruction[], tipLamports, tipAccount, opts.extraSigners);
            }
          } else {
            const nextParsed = parsed;
            const bh = await fetchConfirmedBlockhash(this.ctx.sdkConnection);
            if (nextParsed instanceof VersionedTransaction) {
              (nextParsed.message as any).recentBlockhash = bh.blockhash;
              nextParsed.signatures = nextParsed.signatures.map(() => new Uint8Array(64));
              nextParsed.sign([this.ctx.sdkWallet]);
            } else if (nextParsed instanceof Transaction) {
              nextParsed.recentBlockhash = bh.blockhash;
              nextParsed.signatures = [];
              nextParsed.sign(this.ctx.sdkWallet);
            }
            fallbackBuilt = await this.buildBundleFromTx(nextParsed, tipLamports, tipAccount);
          }
        }
        const fallbackSigs = await this.sendBundleToPublicRPC(fallbackBuilt);
        if (lifecycle && fallbackSigs.length > 0) {
          lifecycle.updateSignatures(result.bundleId, fallbackSigs);
        }
        const landed = await this.awaitConfirmation(result.bundleId);
        const finalLifecycle = (lifecycle ? lifecycle.get(result.bundleId) : null) || lifecycleEntry;
        if (landed) {
          return {
            bundleId: result.bundleId,
            landed: true,
            signature: fallbackSigs[0],
            slot: (finalLifecycle.stages as any).processed?.slot,
            lifecycle: finalLifecycle,
          };
        } else {
          return {
            bundleId: result.bundleId,
            landed: false,
            lifecycle: finalLifecycle,
            error: "Public RPC fallback transaction sent but failed to confirm landing.",
          };
        }
      } catch (err) {
        return {
          bundleId: result.bundleId,
          landed: false,
          lifecycle: (lifecycle ? lifecycle.get(result.bundleId) : null) || lifecycleEntry,
          error: `Public RPC fallback failed: ${String(err)}`,
        };
      }
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

    if (decision.params?.refresh_blockhash && isPresigned) {
      if (!this.canReSign(parsed as VersionedTransaction | Transaction)) {
        const abortMsg = "AI Agent requested refresh_blockhash for a pre-signed transaction. Re-signing requires the private key.";
        db.recordOutcome(result.bundleId, `aborted — ${abortMsg}`);
        return {
          bundleId: result.bundleId,
          landed: false,
          lifecycle: (lifecycle ? lifecycle.get(result.bundleId) : null) || lifecycleEntry,
          error: abortMsg,
        };
      }
    }

    const outcome = await this.runOneRetry(
      { attempt: ctx.attempt + 1, history: nextHistory },
      parsed,
      isPresigned,
      opts,
      decision.params?.refresh_blockhash || !isPresigned || this.canReSign(parsed as VersionedTransaction | Transaction),
      decision.params?.new_tip_lamports || tipLamports,
      decision.params?.submit_at_slot
    );

    db.recordOutcome(result.bundleId, outcome.landed ? `landed @ slot ${outcome.slot}` : `failed retry: ${outcome.error}`);
    return outcome;
  }

  private canReSign(parsed: VersionedTransaction | Transaction): boolean {
    if (!this.ctx.sdkWallet) return false;
    if (parsed instanceof VersionedTransaction) {
      const numSigners = parsed.message.header.numRequiredSignatures;
      if (numSigners === 1) {
        const signerKey = parsed.message.staticAccountKeys[0];
        return !!(signerKey && signerKey.equals(this.ctx.sdkWallet.publicKey));
      }
      return false;
    } else if (parsed instanceof Transaction) {
      const signers = parsed.signatures.map((s) => s.publicKey);
      if (signers.length === 1 && signers[0]) {
        return signers[0].equals(this.ctx.sdkWallet.publicKey);
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
          type: "leader_skip" as const,
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
        nextParsed = parsed;
      } else {
        log.info("Refreshing blockhash and re-signing pre-signed transaction...");
        const bh = await fetchConfirmedBlockhash(this.ctx.sdkConnection);
        if (parsed instanceof VersionedTransaction) {
          (parsed.message as any).recentBlockhash = bh.blockhash;
          parsed.signatures = parsed.signatures.map(() => new Uint8Array(64));
          parsed.sign([this.ctx.sdkWallet]);
        } else if (parsed instanceof Transaction) {
          parsed.recentBlockhash = bh.blockhash;
          parsed.signatures = [];
          parsed.sign(this.ctx.sdkWallet);
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
    const bh = await fetchConfirmedBlockhash(this.ctx.sdkConnection);
    const tipPubkey = new PublicKey(tipAccount);

    const encodedTxs: string[] = [];
    const signatures: string[] = [];

    for (let i = 0; i < bundleTxs.length; i++) {
      const bundleTx = bundleTxs[i];

      const ixs = bundleTx.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId));

      const limit = cuLimits && cuLimits[i] ? cuLimits[i] : 1_400_000;
      ixs.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: limit }));

      const msg = new TransactionMessage({
        payerKey: this.ctx.sdkWallet.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const tx = new VersionedTransaction(msg);

      const signers = [this.ctx.sdkWallet];
      if (bundleTx.signers) {
        signers.push(...bundleTx.signers);
      }
      tx.sign(signers);

      encodedTxs.push(Buffer.from(tx.serialize()).toString("base64"));
      signatures.push(bs58.encode(tx.signatures[0]!));
    }

    const tipIx = SystemProgram.transfer({
      fromPubkey: this.ctx.sdkWallet.publicKey,
      toPubkey: tipPubkey,
      lamports: tipLamports,
    });

    const tipMsg = new TransactionMessage({
      payerKey: this.ctx.sdkWallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: [tipIx],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMsg);
    tipTx.sign([this.ctx.sdkWallet]);

    encodedTxs.push(Buffer.from(tipTx.serialize()).toString("base64"));
    signatures.push(bs58.encode(tipTx.signatures[0]!));

    const slot = await this.ctx.sdkConnection.getSlot("confirmed");

    return {
      encodedTxs,
      signatures,
      tipAccount,
      tipLamports,
      blockhash: bh.blockhash,
      lastValidBlockHeight: slot + 150,
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

    if (!this.ctx.sdkWallet) {
      throw new Error("WALLET_SECRET_KEY is required to sign Jito tip transactions.");
    }

    const tipPubkey = new PublicKey(tipAccount);
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.ctx.sdkWallet.publicKey,
      toPubkey: tipPubkey,
      lamports: tipLamports,
    });

    const tipMsg = new TransactionMessage({
      payerKey: this.ctx.sdkWallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipIx],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMsg);
    tipTx.sign([this.ctx.sdkWallet]);

    const devTxBase64 = Buffer.from(tx.serialize()).toString("base64");
    const tipTxBase64 = Buffer.from(tipTx.serialize()).toString("base64");

    const devSig = tx instanceof VersionedTransaction
      ? bs58.encode(tx.signatures[0]!)
      : bs58.encode(tx.signature!);

    const tipSig = bs58.encode(tipTx.signatures[0]!);

    const slot = await this.ctx.sdkConnection.getSlot("confirmed");

    return {
      encodedTxs: [devTxBase64, tipTxBase64],
      signatures: [devSig, tipSig],
      tipAccount,
      tipLamports,
      blockhash,
      lastValidBlockHeight: slot + 150,
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
    const bh = await fetchConfirmedBlockhash(this.ctx.sdkConnection);
    const tipPubkey = new PublicKey(tipAccount);

    const ixs = instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId));

    ixs.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));

    ixs.push(
      SystemProgram.transfer({
        fromPubkey: this.ctx.sdkWallet.publicKey,
        toPubkey: tipPubkey,
        lamports: tipLamports,
      })
    );

    const msg = new TransactionMessage({
      payerKey: this.ctx.sdkWallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    const signers = [this.ctx.sdkWallet];
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

  private async jitoInvalidFallback(bundleId: string, built: BuiltBundle): Promise<void> {
    const POLL_INTERVAL_MS = 2_000;
    const GIVE_UP_MS = 8_000;
    const deadline = Date.now() + GIVE_UP_MS;

    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);
      try {
        const statuses = await this.ctx.jito.getInflightBundleStatuses([bundleId]);
        const s = statuses.find((x) => x.bundle_id === bundleId);
        if (s?.status === "Invalid") {
          log.warn("bundle marked Invalid by Jito", { bundleId });
          return;
        }
        if (s?.status === "Landed" || s?.status === "Pending") return;
      } catch (err) {
        log.debug("inflight status check failed in fallback", { err: String(err) });
      }
    }
  }

  private async sendBundleToPublicRPC(built: BuiltBundle): Promise<string[]> {
    const signatures: string[] = [];
    const txsToSend = built.encodedTxs.length > 1
      ? built.encodedTxs.slice(0, -1)
      : built.encodedTxs;

    log.info("Sending transactions directly to public RPC TPU path...", {
      txCount: txsToSend.length,
      totalCount: built.encodedTxs.length
    });

    for (const encodedTx of txsToSend) {
      const buf = Buffer.from(encodedTx, "base64");
      const tx = VersionedTransaction.deserialize(buf);
      try {
        const sig = await this.ctx.sdkConnection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        log.info("Public RPC fallback transaction submitted successfully", { sig });
        signatures.push(sig);
      } catch (err) {
        log.error("Failed to submit transaction to public RPC fallback", { err: String(err) });
        throw err;
      }
    }
    return signatures;
  }

  private async pickTipAccount(): Promise<string> {
    const accounts = await this.ctx.jito.getTipAccounts();
    return accounts[Math.floor(Math.random() * accounts.length)]!;
  }

  private async simulateBundleLocally(encodedTxs: string[]): Promise<any> {
    const res = await fetch(this.ctx.sdkConnection.rpcEndpoint, {
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
    const deadline = Date.now() + this.ctx.confirmTimeoutMs;
    const lifecycle = this.ctx.getLifecycle();
    const entry = lifecycle ? lifecycle.get(bundleId) : null;
    const sigs = entry?.signatures ?? [];
    let lastPollAt = 0;

    while (Date.now() < deadline) {
      const current = lifecycle ? lifecycle.get(bundleId) : null;
      if (current?.stages.confirmed) return true;
      if (current?.failure) return false;

      const now = Date.now();
      if (now - lastPollAt >= 3_000) {
        lastPollAt = now;

        try {
          const statuses = await this.ctx.jito.getBundleStatuses([bundleId]);
          const s = statuses.find((x) => x.bundle_id === bundleId);
          if (s && (s.confirmation_status === "confirmed" || s.confirmation_status === "finalized")) {
            log.info("Reconciled bundle confirmation via Jito API", { bundleId, slot: s.slot });
            if (lifecycle) lifecycle.reconcile(bundleId, s.confirmation_status, s.slot);
            return true;
          }
        } catch { /* ignore */ }

        if (sigs.length > 0) {
          try {
            const resp = await this.ctx.sdkConnection.getSignatureStatuses(sigs, { searchTransactionHistory: true });
            if (resp?.value.some((s) => s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"))) {
              const slot = resp.value.find((s) => s)?.slot ?? 0;
              log.info("Reconciled bundle confirmation via RPC", { bundleId, slot });
              if (lifecycle) lifecycle.reconcile(bundleId, "confirmed", slot);
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
