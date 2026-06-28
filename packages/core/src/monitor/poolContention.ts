import { logger } from "../common/logger.js";

const log = logger("contention");

/**
 * Tracks read/write activity on the target pool to calculate a dynamic contention scalar (Alpha_Contention).
 * Uses an Exponential Moving Average (EMA) to establish a baseline, and compares current sliding-window
 * activity against this baseline.
 */
export class PoolContentionTracker {
  private targetPool: string;
  private currentSlot: bigint = 0n;
  private currentSlotTxCount: number = 0;
  
  // EMA Baseline state
  private baselineEma: number = 0;
  private readonly emaAlpha: number = 0.1; // Weight for new data points (10%)
  private readonly minBaseline: number = 5; // Prevent dividing by zero or tiny numbers

  // Sliding window for current activity (e.g., last 5 slots)
  private readonly windowSize: number = 5;
  private windowHistory: number[] = [];

  constructor(targetPool: string) {
    this.targetPool = targetPool;
    for (let i = 0; i < this.windowSize; i++) {
      this.windowHistory.push(0);
    }
  }

  /**
   * Keep the tracker slot in sync and roll the window forward on new slots.
   */
  public updateSlot(slot: bigint): void {
    if (this.currentSlot === 0n) {
      this.currentSlot = slot;
      return;
    }

    if (slot > this.currentSlot) {
      const slotsPassed = Number(slot - this.currentSlot);
      this.flushSlot(this.currentSlot);
      for (let i = 1; i < Math.min(slotsPassed, this.windowSize); i++) {
        this.windowHistory.shift();
        this.windowHistory.push(0);
      }
      this.currentSlot = slot;
    }
  }

  /**
   * Called for every transaction received on the stream.
   */
  public observeTransaction(slot: bigint): void {
    this.updateSlot(slot);
    if (slot < this.currentSlot) {
      return;
    }
    this.currentSlotTxCount++;
  }

  /**
   * Rolls the window forward and updates the EMA when a slot concludes.
   */
  public flushSlot(slot: bigint): void {
    if (this.currentSlotTxCount === 0 && this.baselineEma === 0) {
      return; // Not initialized yet or empty
    }

    // Update window
    this.windowHistory.shift();
    this.windowHistory.push(this.currentSlotTxCount);

    // Update EMA (only if we have some data to prevent skewing baseline to 0 instantly)
    if (this.baselineEma === 0) {
      this.baselineEma = Math.max(this.currentSlotTxCount, this.minBaseline);
    } else {
      this.baselineEma = (this.currentSlotTxCount * this.emaAlpha) + (this.baselineEma * (1 - this.emaAlpha));
    }

    this.currentSlotTxCount = 0; // reset for next slot
  }

  /**
   * Returns Alpha_Contention (current window average / baseline EMA).
   * Minimum 1.0. Max capped at 5.0 to prevent runaway tips.
   */
  public getAlphaContention(): number {
    const currentTotal = this.windowHistory.reduce((a, b) => a + b, 0);
    const windowAverage = currentTotal / this.windowSize;

    const safeBaseline = Math.max(this.baselineEma, this.minBaseline);
    const alpha = windowAverage / safeBaseline;

    // Clamp between 1.0 (no extra tip) and 5.0 (extreme contention)
    return Math.min(5.0, Math.max(1.0, alpha));
  }

  public getTargetPool(): string {
    return this.targetPool;
  }
}
