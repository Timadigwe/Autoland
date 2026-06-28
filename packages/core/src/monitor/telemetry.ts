import { Connection } from "@solana/web3.js";
import { config } from "../config.js";
import { logger } from "../common/logger.js";
import { getNextScheduledLeader as jitoNextLeader, type NextScheduledLeader } from "../dispatch/client.js";

const log = logger("telemetry");

interface SlotRecord {
  slot: bigint;
  processedAt?: number;
  confirmedAt?: number;
  finalizedAt?: number;
}

export interface CongestionSnapshot {
  windowSize: number;
  skipRate: number;
  p2cMsP50: number;
  p2cMsP95: number;
  congestionMultiplier: number;
  sampleCount: number;
}

const MAX_MULTIPLIER = 3.0;
const HEALTHY_P2C_MS = 600;
const SEVERE_SKIP_RATE = 0.15;

export class CongestionOracle {
  private ring: SlotRecord[] = [];
  private index = new Map<string, SlotRecord>();
  private readonly capacity: number;

  constructor(capacity = config.congestion.ringSize) {
    this.capacity = capacity;
  }

  ingest(ev: { slot: bigint; status: "processed" | "confirmed" | "finalized"; ts: number }): void {
    const key = ev.slot.toString();
    let rec = this.index.get(key);
    if (!rec) {
      rec = { slot: ev.slot };
      this.index.set(key, rec);
      this.ring.push(rec);
      while (this.ring.length > this.capacity) {
        const old = this.ring.shift()!;
        this.index.delete(old.slot.toString());
      }
    }
    if (ev.status === "processed" && rec.processedAt === undefined) rec.processedAt = ev.ts;
    else if (ev.status === "confirmed" && rec.confirmedAt === undefined) rec.confirmedAt = ev.ts;
    else if (ev.status === "finalized" && rec.finalizedAt === undefined) rec.finalizedAt = ev.ts;
  }

  snapshot(): CongestionSnapshot {
    const recs = this.ring;
    const windowSize = recs.length;

    const recencyGuard = 8;
    const candidates = recs.slice(0, Math.max(0, windowSize - recencyGuard));
    let skipped = 0;
    let consideredForSkip = 0;
    for (const r of candidates) {
      if (r.processedAt !== undefined) {
        consideredForSkip++;
        if (r.confirmedAt === undefined) skipped++;
      }
    }
    const skipRate = consideredForSkip > 0 ? skipped / consideredForSkip : 0;

    const deltas: number[] = [];
    for (const r of recs) {
      if (r.processedAt !== undefined && r.confirmedAt !== undefined && r.confirmedAt >= r.processedAt) {
        deltas.push(r.confirmedAt - r.processedAt);
      }
    }
    const p2cMsP50 = percentile(deltas, 50);
    const p2cMsP95 = percentile(deltas, 95);

    const congestionMultiplier = this.computeMultiplier(skipRate, p2cMsP50);

    return {
      windowSize,
      skipRate,
      p2cMsP50,
      p2cMsP95,
      congestionMultiplier,
      sampleCount: deltas.length,
    };
  }

  private computeMultiplier(skipRate: number, p2cMsP50: number): number {
    const latencyPressure = clamp01((p2cMsP50 - HEALTHY_P2C_MS) / (HEALTHY_P2C_MS * 4));
    const skipPressure = clamp01(skipRate / SEVERE_SKIP_RATE);
    const pressure = clamp01(0.45 * latencyPressure + 0.55 * skipPressure);
    return 1 + pressure * (MAX_MULTIPLIER - 1);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

const LEADER_SLOTS = 4;
const SUBMIT_LEAD_SLOTS = 2;

export interface LeaderWindow {
  currentSlot: number;
  nextJitoLeaderSlot: number;
  nextJitoLeaderIdentity: string;
  slotsUntilJitoLeader: number;
  inSubmitWindow: boolean;
  region?: string;
}

export class LeaderWindowDetector {
  private nextLeaderCache?: { value: NextScheduledLeader; at: number };
  private leaderSchedule?: { epoch: number; slots: Set<number> };
  private readonly cacheTtlMs: number;

  constructor(cacheTtlMs = 2000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  async window(): Promise<LeaderWindow> {
    const next = await this.nextLeader();
    const slotsUntil = next.nextLeaderSlot - next.currentSlot;
    const inSubmitWindow =
      slotsUntil <= SUBMIT_LEAD_SLOTS && slotsUntil > -(LEADER_SLOTS);

    return {
      currentSlot: next.currentSlot,
      nextJitoLeaderSlot: next.nextLeaderSlot,
      nextJitoLeaderIdentity: next.nextLeaderIdentity,
      slotsUntilJitoLeader: slotsUntil,
      inSubmitWindow,
      region: next.nextLeaderRegion,
    };
  }

  private async nextLeader(): Promise<NextScheduledLeader> {
    const now = Date.now();
    if (this.nextLeaderCache && now - this.nextLeaderCache.at < this.cacheTtlMs) {
      return this.nextLeaderCache.value;
    }
    const value = await jitoNextLeader();
    this.nextLeaderCache = { value, at: now };
    return value;
  }

  async ensureLeaderSchedule(conn: Connection): Promise<void> {
    const epochInfo = await conn.getEpochInfo();
    if (this.leaderSchedule?.epoch === epochInfo.epoch) return;
    const schedule = await conn.getLeaderSchedule();
    const slots = new Set<number>();
    if (schedule) {
      const epochStart = epochInfo.absoluteSlot - epochInfo.slotIndex;
      for (const indices of Object.values(schedule)) {
        for (const i of indices as number[]) slots.add(epochStart + i);
      }
    }
    this.leaderSchedule = { epoch: epochInfo.epoch, slots };
    log.info("Leader schedule cached", { epoch: epochInfo.epoch, slots: slots.size });
  }
}
