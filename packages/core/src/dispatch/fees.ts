import { config } from "../config.js";
import { logger } from "../common/logger.js";

const logFloor = logger("tipfloor");
const logModel = logger("tip-model");

export interface TipFloor {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  ema: number;
  fetchedAt: number;
}

export type TipPercentileKey = "p25" | "p50" | "p75" | "p95" | "p99";

const LAMPORTS_PER_SOL = 1_000_000_000;

interface RawTipFloor {
  time: string;
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

export class TipFloorService {
  private cache?: TipFloor;
  constructor(
    private readonly url = config.jito.tipFloorUrl,
    private readonly ttlMs = 60_000,
  ) {}

  getCached(): TipFloor | undefined {
    return this.cache;
  }

  async get(): Promise<TipFloor> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) return this.cache;
    try {
      const fresh = await this.fetch();
      this.cache = fresh;
      return fresh;
    } catch (err) {
      if (this.cache) {
        logFloor.warn("tip_floor refetch failed; serving stale", { err: String(err) });
        return this.cache;
      }
      throw err;
    }
  }

  private async fetch(): Promise<TipFloor> {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`tip_floor HTTP ${res.status}`);
    const json = (await res.json()) as RawTipFloor[];
    const row = json[0];
    if (!row) throw new Error("tip_floor returned empty array");
    const toLamports = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);
    const tf: TipFloor = {
      p25: toLamports(row.landed_tips_25th_percentile),
      p50: toLamports(row.landed_tips_50th_percentile),
      p75: toLamports(row.landed_tips_75th_percentile),
      p95: toLamports(row.landed_tips_95th_percentile),
      p99: toLamports(row.landed_tips_99th_percentile),
      ema: toLamports(row.ema_landed_tips_50th_percentile),
      fetchedAt: Date.now(),
    };
    logFloor.debug("tip_floor fetched", tf as unknown as Record<string, unknown>);
    return tf;
  }
}

let _svc: TipFloorService | undefined;
export function tipFloorService(): TipFloorService {
  if (!_svc) _svc = new TipFloorService();
  return _svc;
}

// ---- Tip calculation model ----

export type Urgency = "low" | "normal" | "high";

export interface TipInputs {
  tipFloor: TipFloor;
  congestionMultiplier: number;
  alphaContention?: number;
  cuScalar?: number;
  urgency?: Urgency;
  percentileTarget?: TipPercentileKey;
  maxCompetitorTipPerCU?: number;
  expectedProfitLamports?: number;
  maxProfitSharePct?: number;
}

export interface TipDecision {
  lamports: number;
  percentileKey: TipPercentileKey;
  basePercentileLamports: number;
  congestionMultiplier: number;
  ceilingLamports: number;
  clamped: boolean;
  competitorScaled?: boolean;
  profitCapped?: boolean;
}

export function selectPercentile(inputs: TipInputs): { key: TipPercentileKey; dynamicMultiplier: number } {
  const { tipFloor, congestionMultiplier, urgency = "normal" } = inputs;
  let level = urgency === "low" ? 0 : urgency === "high" ? 3 : 1;

  let spreadMultiplier = 1.0;
  if (tipFloor.ema > 0) {
    const spread = tipFloor.p95 / tipFloor.ema;
    if (spread > 50) {
      level += 2;
    } else if (spread > 15) {
      level += 1;
    }
  }

  if (tipFloor.ema > 0 && tipFloor.p50 > tipFloor.ema * 1.5) {
    spreadMultiplier = 1.25;
  }

  const ladder: TipPercentileKey[] = ["p25", "p50", "p75", "p95", "p99"];
  const idx = Math.min(ladder.length - 1, Math.max(0, level));
  return { key: ladder[idx]!, dynamicMultiplier: spreadMultiplier };
}

export function computeTip(inputs: TipInputs): TipDecision {
  const { 
    tipFloor, 
    congestionMultiplier, 
    alphaContention = 1.0, 
    cuScalar = 4.0,
    maxCompetitorTipPerCU = 0,
    expectedProfitLamports,
    maxProfitSharePct = 0.90
  } = inputs;
  
  const dynamic = selectPercentile(inputs);
  const percentileKey = inputs.percentileTarget ?? dynamic.key;
  const basePercentileLamports = tipFloor[percentileKey];

  const kPremium = 1.10;
  
  const scaledTip = cuScalar * basePercentileLamports * alphaContention;
  let targetTip = Math.max(basePercentileLamports, scaledTip);
  let competitorScaled = false;
  let profitCapped = false;

  if (maxCompetitorTipPerCU > 0) {
    const estimatedCUs = cuScalar * 50_000;
    const competitorBaseTip = maxCompetitorTipPerCU * estimatedCUs;
    const competitorTargetTip = competitorBaseTip * kPremium;
    
    if (competitorTargetTip > targetTip) {
      targetTip = competitorTargetTip;
      competitorScaled = true;
      logModel.info(`[TIP_MATH] Competitor active on pool. Target competitor tip: ${Math.round(competitorTargetTip)} lamports (based on ${maxCompetitorTipPerCU.toFixed(4)} lamports/CU). Outbidding.`);
    }
  }

  if (expectedProfitLamports !== undefined && expectedProfitLamports > 0) {
    const minAlpha = 0.40;
    const alpha = Math.min(maxProfitSharePct, minAlpha + (alphaContention - 1.0) * 0.125);
    const profitSplitTip = expectedProfitLamports * alpha;
    
    if (profitSplitTip > targetTip) {
      targetTip = profitSplitTip;
      logModel.info(`[TIP_MATH] Contested state. Scaling tip to profit-share target of ${(alpha * 100).toFixed(1)}%: ${Math.round(profitSplitTip)} lamports (Profit: ${expectedProfitLamports}).`);
    }
    
    const hardCap = expectedProfitLamports * maxProfitSharePct;
    if (targetTip > hardCap) {
      targetTip = hardCap;
      profitCapped = true;
      logModel.info(`[TIP_MATH] Calculated tip exceeds hard budget cap of ${(maxProfitSharePct * 100).toFixed(0)}%: capping at ${Math.round(hardCap)} lamports.`);
    }
  }

  const raw = Math.floor(targetTip);

  const floor = Math.max(tipFloor.p25, config.tips.floorLamports);
  const ceiling = config.tips.ceilingLamports;
  const clampedLamports = Math.min(ceiling, Math.max(floor, raw));
  
  logModel.info(`[TIP_MATH] Selected Percentile: ${percentileKey} (${basePercentileLamports} lamports) | Final Tip: ${clampedLamports} lamports`);

  return {
    lamports: clampedLamports,
    percentileKey,
    basePercentileLamports,
    congestionMultiplier,
    ceilingLamports: ceiling,
    clamped: clampedLamports !== raw,
    competitorScaled,
    profitCapped
  };
}
