import { logger } from "../common/logger.js";
import { db } from "./db.js";
import { StreamManager, type TxEvent, type Commitment } from "../monitor/connection.js";
import type { SubmitResult } from "../dispatch/sender.js";
import { Connection, type SignatureResult, type Context } from "@solana/web3.js";

const log = logger("lifecycle");

export type Stage = "submitted" | "processed" | "confirmed" | "finalized";

export interface StageStamp {
  slot: number;
  ts: string;
}

export type FailureClass =
  | "blockhash_expired"
  | "fee_too_low"
  | "compute_exceeded"
  | "leader_skip"
  | "bundle_dropped"
  | "simulation_failed"
  | "jito_api_error";

export interface FailureRecord {
  type: FailureClass;
  evidence: Record<string, unknown>;
  detectedAtSlot: number;
  ts: string;
}

export interface LifecycleEntry {
  bundle_id: string;
  signatures: string[];
  tip_lamports: number;
  tip_account: string;
  attempt: number;
  stages: Partial<Record<Stage, StageStamp>>;
  deltas_ms: {
    submitted_to_processed?: number;
    processed_to_confirmed?: number;
    confirmed_to_finalized?: number;
  };
  failure: FailureRecord | null;
  confirmed_via: "stream" | "status_api" | null;
}

interface TrackedBundle {
  entry: LifecycleEntry;
  stageMs: Partial<Record<Stage, number>>;
  primarySig: string;
  done: boolean;
}

const stageOrder: Stage[] = ["submitted", "processed", "confirmed", "finalized"];

export class LifecycleTracker {
  private bundles = new Map<string, TrackedBundle>();
  private sigIndex = new Map<string, string>();
  private landedSlot = new Map<number, Set<string>>();

  constructor(
    private readonly connection?: Connection,
    private readonly stream?: StreamManager
  ) {}

  active(): LifecycleEntry[] {
    return [...this.bundles.values()].filter((b) => !b.done).map((b) => b.entry);
  }

  get(bundleId: string): LifecycleEntry | undefined {
    return this.bundles.get(bundleId)?.entry;
  }

  track(sub: SubmitResult, attempt: number, submittedSlot: number): void {
    const ts = new Date(sub.submittedAt).toISOString();
    const entry: LifecycleEntry = {
      bundle_id: sub.bundleId,
      signatures: sub.signatures,
      tip_lamports: sub.tipLamports,
      tip_account: sub.tipAccount,
      attempt,
      stages: { submitted: { slot: submittedSlot, ts } },
      deltas_ms: {},
      failure: null,
      confirmed_via: null,
    };
    const tracked: TrackedBundle = {
      entry,
      stageMs: { submitted: sub.submittedAt },
      primarySig: sub.signatures[0] ?? sub.bundleId,
      done: false,
    };
    this.bundles.set(sub.bundleId, tracked);
    for (const sig of sub.signatures) this.sigIndex.set(sig, sub.bundleId);
    log.info("tracking bundle", { bundleId: sub.bundleId, attempt, submittedSlot });

    if (this.stream) {
      for (const sig of sub.signatures) {
        this.stream.trackSignature(sig);
      }
    }
  }

  onTxEvent(ev: TxEvent, commitment: Commitment): void {
    const bundleId = this.sigIndex.get(ev.signature);
    if (!bundleId) return;
    const tracked = this.bundles.get(bundleId);
    if (!tracked || tracked.done) return;
    const slot = Number(ev.slot);
    let set = this.landedSlot.get(slot);
    if (!set) {
      set = new Set();
      this.landedSlot.set(slot, set);
    }
    set.add(bundleId);
    this.advance(tracked, commitment, slot, ev.ts, "stream");
  }

  onSlotStatus(slot: number, commitment: Commitment, tsMs: number): void {
    if (commitment === "processed") return;
    const ids = this.landedSlot.get(slot);
    if (!ids) return;
    for (const bundleId of ids) {
      const tracked = this.bundles.get(bundleId);
      if (tracked && !tracked.done) this.advance(tracked, commitment, slot, tsMs, "stream");
    }
  }

  reconcile(bundleId: string, commitment: Commitment, slot: number): void {
    const tracked = this.bundles.get(bundleId);
    if (!tracked || tracked.done) return;
    if (!tracked.entry.stages[commitment]) {
      this.advance(tracked, commitment, slot, Date.now(), "status_api");
    }
  }

  fail(bundleId: string, failure: FailureRecord): void {
    const tracked = this.bundles.get(bundleId);
    if (!tracked || tracked.done) return;
    tracked.entry.failure = failure;
    this.finish(tracked);
    log.warn("bundle failed", { bundleId, type: failure.type });
  }

  prepareForFallback(bundleId: string): void {
    const tracked = this.bundles.get(bundleId);
    if (!tracked) return;
    tracked.entry.failure = null;
    tracked.done = false;
    for (const sig of tracked.entry.signatures) {
      this.sigIndex.set(sig, bundleId);
    }
    log.info("prepared bundle for fallback tracking", { bundleId });
  }

  updateSignatures(bundleId: string, signatures: string[]): void {
    const tracked = this.bundles.get(bundleId);
    if (!tracked) return;

    // Remove old mappings from sigIndex
    for (const sig of tracked.entry.signatures) {
      this.sigIndex.delete(sig);
      if (this.stream) {
        try {
          this.stream.untrackSignature(sig);
        } catch { /* ignore */ }
      }
    }

    // Set new signatures
    tracked.entry.signatures = signatures;

    // Add new mappings and track them
    for (const sig of signatures) {
      this.sigIndex.set(sig, bundleId);
      if (this.stream) {
        try {
          this.stream.trackSignature(sig);
        } catch { /* ignore */ }
      }
    }
    log.info("Updated tracked bundle with fallback RPC signatures", { bundleId, signatures });
  }

  private advance(
    tracked: TrackedBundle,
    commitment: Commitment,
    slot: number,
    tsMs: number,
    via: "stream" | "status_api",
  ): void {
    const stage = commitment as Stage;
    if (tracked.entry.stages[stage]) return;

    const stamp: StageStamp = { slot, ts: new Date(tsMs).toISOString() };
    tracked.entry.stages[stage] = stamp;
    tracked.stageMs[stage] = tsMs;

    if (stage === "confirmed" && tracked.entry.confirmed_via === null) {
      tracked.entry.confirmed_via = via;
    }

    this.recomputeDeltas(tracked);

    log.debug("stage advanced", { bundleId: tracked.entry.bundle_id, stage, slot, via });

    if (stage === "finalized") this.finish(tracked);
  }

  private recomputeDeltas(tracked: TrackedBundle): void {
    const m = tracked.stageMs;
    const d = tracked.entry.deltas_ms;
    if (m.submitted !== undefined && m.processed !== undefined)
      d.submitted_to_processed = m.processed - m.submitted;
    if (m.processed !== undefined && m.confirmed !== undefined)
      d.processed_to_confirmed = m.confirmed - m.processed;
    if (m.confirmed !== undefined && m.finalized !== undefined)
      d.confirmed_to_finalized = m.finalized - m.confirmed;
  }

  private finish(tracked: TrackedBundle): void {
    if (tracked.done) return;
    tracked.done = true;
    db.recordLifecycle(tracked.entry);
    for (const sig of tracked.entry.signatures) {
      this.sigIndex.delete(sig);
      if (this.stream) {
        try {
          this.stream.untrackSignature(sig);
        } catch { /* ignore */ }
      }
    }
    const landedAt = tracked.entry.stages.processed?.slot;
    if (landedAt !== undefined) this.landedSlot.get(landedAt)?.delete(tracked.entry.bundle_id);
  }

  stageRank(stage: Stage): number {
    return stageOrder.indexOf(stage);
  }
}
