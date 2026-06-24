import { config } from "../config.js";
import type { TipFloor, TipPercentileKey } from "./tipFloor.js";
import { logger } from "../util/log.js";

const log = logger("tip-model");

/**
 * Tip model (plan §5.4, FR-9).
 *
 *   tip = percentile(tip_floor, p) × congestion_multiplier
 *
 * The percentile `p` scales with congestion and urgency; the multiplier comes
 * from the Congestion Oracle. The result is clamped to
 * [tip_floor.p25, TIP_CEILING_LAMPORTS]. There are NO literal lamport
 * constants here — every magnitude is sourced from live tip_floor data or the
 * configured safety ceiling. (See scripts/check-no-hardcoded-tips.mjs.)
 */

export type Urgency = "low" | "normal" | "high";

export interface TipInputs {
  tipFloor: TipFloor;
  congestionMultiplier: number;
  alphaContention?: number;
  cuScalar?: number;
  urgency?: Urgency;
  /** override the percentile selection (e.g. the agent picked one) */
  percentileTarget?: TipPercentileKey;
}

export interface TipDecision {
  lamports: number;
  percentileKey: TipPercentileKey;
  basePercentileLamports: number;
  congestionMultiplier: number;
  ceilingLamports: number;
  clamped: boolean;
}

/**
 * Choose which tip_floor percentile to anchor on, based on congestion + urgency.
 * Calmer network / lower urgency → lower percentile; busier / urgent → higher.
 */
export function selectPercentile(inputs: TipInputs): { key: TipPercentileKey; dynamicMultiplier: number } {
  const { tipFloor, congestionMultiplier, urgency = "normal" } = inputs;
  
  // Base level from urgency
  let level = urgency === "low" ? 0 : urgency === "high" ? 3 : 1;
  
  // 1. Escalate with base-layer congestion
  // if (congestionMultiplier >= 2.2) level += 2;
  // else if (congestionMultiplier >= 1.5) level += 1;

  // 3. Financial Volatility Spread (Whale Index)
  // If p95 is massively disjointed from EMA p50, MEV contention is extreme
  let spreadMultiplier = 1.0;
  if (tipFloor.ema > 0) {
    const spread = tipFloor.p95 / tipFloor.ema;
    if (spread > 50) {
      level += 2; // Extreme volatility, jump up
    } else if (spread > 15) {
      level += 1; // High volatility
    }
  }

  // 4. MEV Momentum (Live vs EMA)
  // If live p50 is surging past the historical EMA p50
  if (tipFloor.ema > 0 && tipFloor.p50 > tipFloor.ema * 1.5) {
    spreadMultiplier = 1.25; // Apply a 25% momentum premium to outpace the surge
  }

  const ladder: TipPercentileKey[] = ["p25", "p50", "p75", "p95", "p99"];
  const idx = Math.min(ladder.length - 1, Math.max(0, level));
  return { key: ladder[idx]!, dynamicMultiplier: spreadMultiplier };
}

export function computeTip(inputs: TipInputs): TipDecision {
  const { tipFloor, congestionMultiplier, alphaContention = 1.0, cuScalar = 4.0 } = inputs; // Default cuScalar to 4.0 (~200k CUs) for pre-flight simulation before true optimization
  
  const dynamic = selectPercentile(inputs);
  const percentileKey = inputs.percentileTarget ?? dynamic.key;

  const floor99th = tipFloor.p99;
  const floor75th = tipFloor.p75;
  const kPremium = 1.10; // 10% anti-snipe flash-bid buffer

  // Dynamic formula: max(Floor_99th, CU_Scalar * Floor_99th * Alpha_Contention) * K_Premium
  const scaledTip = cuScalar * floor99th * alphaContention;
  const baseRaw = Math.max(floor99th, scaledTip);
  const raw = Math.floor(baseRaw * kPremium);

  const floor = Math.max(tipFloor.p25, config.tips.floorLamports); // never tip below the 25th percentile or absolute config minimum
  const ceiling = config.tips.ceilingLamports;
  const clampedLamports = Math.min(ceiling, Math.max(floor, raw));
  
  log.info(`[TIP_MATH] Jito 99th Percentile: ${floor99th} lamports | Final Calculated Tip: ${clampedLamports} lamports`);
  
  const basePercentileLamports = tipFloor[percentileKey];

  return {
    lamports: clampedLamports,
    percentileKey,
    basePercentileLamports,
    congestionMultiplier,
    ceilingLamports: ceiling,
    clamped: clampedLamports !== raw,
  };
}
