import { logger } from "../common/logger.js";
import bs58 from "bs58";
import { JITO_TIP_ACCOUNTS } from "../common/constants.js";

const log = logger("competitor-tracker");


export class CompetitorTipTracker {
  private targetPool: string;
  private currentSlot: bigint = 0n;

  // Track the highest tip-per-CU seen in the current slot
  private currentSlotMaxTipPerCU = 0;

  // Sliding window of the max tip-per-CU for the last 5 slots
  private readonly windowSize = 5;
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
      this.flushSlot();
      for (let i = 1; i < Math.min(slotsPassed, this.windowSize); i++) {
        this.windowHistory.shift();
        this.windowHistory.push(0);
      }
      this.currentSlot = slot;
    }
  }

  /**
   * Observe a transaction from the Yellowstone stream.
   * Extracts Jito tip and compute units to calculate tip-per-CU.
   */
  public observeTransaction(slot: bigint, txInfo: any, jitoTipAccountIndex?: number): void {
    this.updateSlot(slot);
    if (slot < this.currentSlot) {
      return; // Ignore old slots
    }

    try {
      const message = txInfo.transaction?.message;
      if (!message || !message.accountKeys) return;

      let finalIndex = jitoTipAccountIndex !== undefined ? jitoTipAccountIndex : -1;
      if (finalIndex === -1) {
        // Fallback: Scan static account keys for Jito tip accounts
        const accountKeys = message.accountKeys;
        for (let i = 0; i < accountKeys.length; i++) {
          const key = accountKeys[i];
          const pubkeyStr = typeof key === "string" ? key : bs58.encode(key);
          if (JITO_TIP_ACCOUNTS.has(pubkeyStr)) {
            finalIndex = i;
            break;
          }
        }
      }

      if (finalIndex === -1) return; // No Jito tip account used

      // Calculate tip amount: postBalances - preBalances for Jito tip account
      const preBalances = txInfo.meta?.preBalances;
      const postBalances = txInfo.meta?.postBalances;
      if (!preBalances || !postBalances) return;

      const preBalance = Number(preBalances[finalIndex] ?? 0);
      const postBalance = Number(postBalances[finalIndex] ?? 0);
      const tipAmount = postBalance - preBalance;

      if (tipAmount <= 0) return;

      // Extract compute units consumed
      const computeUnitsConsumed = Number(txInfo.meta?.computeUnitsConsumed ?? 0);
      if (computeUnitsConsumed <= 0) return;

      const tipPerCU = tipAmount / computeUnitsConsumed;
      if (tipPerCU > this.currentSlotMaxTipPerCU) {
        this.currentSlotMaxTipPerCU = tipPerCU;
        log.info(`[COMPETITOR] Dynamic Jito Tip/CU updated on pool ${this.targetPool} in slot ${slot}: ${tipPerCU.toFixed(4)} lamports/CU (Tip: ${tipAmount} lamports, CU: ${computeUnitsConsumed})`);
      }
    } catch (err) {
      log.warn("Error parsing competitor transaction", { err: String(err) });
    }
  }

  public flushSlot(): void {
    this.windowHistory.shift();
    this.windowHistory.push(this.currentSlotMaxTipPerCU);
    this.currentSlotMaxTipPerCU = 0;
  }

  /**
   * Returns the maximum tip-per-CU observed in the sliding window.
   */
  public getMaxTipPerCU(): number {
    return Math.max(...this.windowHistory);
  }
}
