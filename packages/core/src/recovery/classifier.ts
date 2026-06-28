import type { FailureClass, FailureRecord } from "./tracker.js";
import type { CongestionSnapshot } from "../monitor/telemetry.js";

export interface ClassifierInput {
  bundleId: string;
  currentSlot: number;
  lastValidBlockHeight?: number;
  currentBlockHeight?: number;
  blockhashFetchedAtSlot?: number;
  targetLeaderSlot?: number;
  leaderSlotSkipped?: boolean;
  tipLamports?: number;
  tipFloorP50?: number;
  neverProcessed?: boolean;
  congestion?: CongestionSnapshot;
  simulationError?: string | null;
  computeError?: boolean;
}

export function classifyFailure(input: ClassifierInput): FailureRecord {
  const ts = new Date().toISOString();
  const base = { detectedAtSlot: input.currentSlot, ts };

  if (input.simulationError) {
    if (input.computeError || /compute|exceeded budget|exceeded CUs/i.test(input.simulationError)) {
      return mk("compute_exceeded", base, { simulationError: input.simulationError });
    }
    return mk("simulation_failed", base, { simulationError: input.simulationError });
  }
  if (input.computeError) {
    return mk("compute_exceeded", base, { reason: "compute budget exceeded" });
  }

  if (
    input.lastValidBlockHeight !== undefined &&
    input.currentBlockHeight !== undefined &&
    input.currentBlockHeight > input.lastValidBlockHeight
  ) {
    const ageSlots =
      input.blockhashFetchedAtSlot !== undefined
        ? input.currentSlot - input.blockhashFetchedAtSlot
        : undefined;
    return mk("blockhash_expired", base, {
      last_valid_block_height: input.lastValidBlockHeight,
      current_block_height: input.currentBlockHeight,
      blockhash_age_slots: ageSlots,
    });
  }

  if (input.leaderSlotSkipped) {
    return mk("leader_skip", base, {
      target_leader_slot: input.targetLeaderSlot,
      observed_skip: true,
    });
  }

  if (
    input.neverProcessed &&
    input.tipLamports !== undefined &&
    input.tipFloorP50 !== undefined &&
    input.tipLamports < input.tipFloorP50 &&
    (input.congestion?.congestionMultiplier ?? 1) > 1.3
  ) {
    return mk("fee_too_low", base, {
      tip_lamports: input.tipLamports,
      tip_floor_p50: input.tipFloorP50,
      congestion_multiplier: input.congestion?.congestionMultiplier,
      skip_rate: input.congestion?.skipRate,
    });
  }

  if (input.neverProcessed) {
    return mk("bundle_dropped", base, {
      target_leader_slot: input.targetLeaderSlot,
      note: "never processed; no specific signal — treated as drop",
      congestion_multiplier: input.congestion?.congestionMultiplier,
    });
  }
  return mk("simulation_failed", base, { note: "unclassified failure" });
}

function mk(
  type: FailureClass,
  base: { detectedAtSlot: number; ts: string },
  evidence: Record<string, unknown>,
): FailureRecord {
  return { type, evidence, ...base };
}
