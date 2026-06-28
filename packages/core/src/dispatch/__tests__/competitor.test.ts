import { describe, it, expect, vi } from "vitest";
import { CompetitorTipTracker } from "../../monitor/competitorTips.js";
import { computeTip } from "../fees.js";
import type { TipFloor } from "../fees.js";

vi.mock("@triton-one/yellowstone-grpc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@triton-one/yellowstone-grpc")>();
  return {
    ...original,
    txEncode: {
      encode: (txInfo: any) => txInfo
    }
  };
});

const DUMMY_JITO_TIP_ADDR = "DttWaJV8nDsMMn5YDG49Bw249Xy6vM969ue66DcEsZ7N";

const mockTipFloor: TipFloor = {
  p25: 10_000,
  p50: 20_000,
  p75: 50_000,
  p95: 200_000,
  p99: 1_000_000,
  ema: 25_000,
  fetchedAt: Date.now()
};

describe("CompetitorTipTracker & Dynamic Bidding Model", () => {
  describe("CompetitorTipTracker", () => {
    it("should ignore transactions without Jito tip transfers", () => {
      const tracker = new CompetitorTipTracker("mockPool");
      
      const txInfo = {
        transaction: {
          message: {
            accountKeys: [
              "dummy1",
              "dummy2"
            ]
          }
        },
        meta: {
          preBalances: [1000000, 1000000],
          postBalances: [990000, 1010000],
          computeUnitsConsumed: 50000
        }
      };

      tracker.observeTransaction(100n, txInfo);
      expect(tracker.getMaxTipPerCU()).toBe(0);
    });

    it("should extract competitor Tip/CU from Jito tip transactions", () => {
      const tracker = new CompetitorTipTracker("mockPool");
      
      const txInfo = {
        transaction: {
          message: {
            accountKeys: [
              "dummy1",
              DUMMY_JITO_TIP_ADDR
            ]
          }
        },
        meta: {
          preBalances: [10_000_000, 2_000_000],
          postBalances: [4_900_000, 7_000_000],
          computeUnitsConsumed: 50_000
        }
      };

      tracker.observeTransaction(100n, txInfo);
      tracker.flushSlot();
      expect(tracker.getMaxTipPerCU()).toBe(100);
    });

    it("should maintain sliding window and track max values across slots", () => {
      const tracker = new CompetitorTipTracker("mockPool");
      
      tracker.observeTransaction(100n, {
        transaction: { message: { accountKeys: [DUMMY_JITO_TIP_ADDR] } },
        meta: { preBalances: [1_000], postBalances: [2_501_000], computeUnitsConsumed: 50_000 }
      });

      tracker.observeTransaction(101n, {
        transaction: { message: { accountKeys: [DUMMY_JITO_TIP_ADDR] } },
        meta: { preBalances: [1_000], postBalances: [1_001_000], computeUnitsConsumed: 10_000 }
      });

      tracker.observeTransaction(103n, {
        transaction: { message: { accountKeys: [DUMMY_JITO_TIP_ADDR] } },
        meta: { preBalances: [1_000], postBalances: [2_001_000], computeUnitsConsumed: 100_000 }
      });

      tracker.flushSlot();
      expect(tracker.getMaxTipPerCU()).toBe(100);
    });
  });

  describe("computeTip Advanced Logic", () => {
    it("should calculate baseline scaled tip using selectPercentile and cuScalar", () => {
      const decision = computeTip({
        tipFloor: mockTipFloor,
        congestionMultiplier: 1.0,
        alphaContention: 1.0,
        cuScalar: 1.5,
        urgency: "normal"
      });

      expect(decision.lamports).toBe(30_000);
      expect(decision.percentileKey).toBe("p50");
    });

    it("should scale tip to beat active competitors on target pool", () => {
      const decision = computeTip({
        tipFloor: mockTipFloor,
        congestionMultiplier: 1.0,
        alphaContention: 1.0,
        cuScalar: 1.0,
        maxCompetitorTipPerCU: 100,
        urgency: "normal"
      });

      expect(decision.lamports).toBe(5_500_000);
      expect(decision.competitorScaled).toBe(true);
    });

    it("should scale tip dynamically based on expectedProfit and contention", () => {
      const decision = computeTip({
        tipFloor: mockTipFloor,
        congestionMultiplier: 1.0,
        alphaContention: 1.0,
        cuScalar: 1.0,
        expectedProfitLamports: 10_000_000,
        maxProfitSharePct: 0.85
      });

      expect(decision.lamports).toBe(4_000_000);
    });

    it("should hard cap final tip to profit budget margin", () => {
      const decision = computeTip({
        tipFloor: mockTipFloor,
        congestionMultiplier: 1.0,
        alphaContention: 3.0,
        cuScalar: 10.0,
        maxCompetitorTipPerCU: 500,
        expectedProfitLamports: 1_000_000,
        maxProfitSharePct: 0.80
      });

      expect(decision.lamports).toBe(800_000);
      expect(decision.profitCapped).toBe(true);
    });
  });
});
