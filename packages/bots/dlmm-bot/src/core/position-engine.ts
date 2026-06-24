import { Keypair } from "@solana/web3.js";
import { BotConfig } from "../types/config";
import { PositionState } from "../types/execution-state";
import { RebalanceBuilder } from "../execution/rebalance-builder";
import { Logger } from "../utils/logger";

export interface PositionEvaluation {
  state: PositionState;
  activeBin: number;
  minBin: number | null;
  maxBin: number | null;
  driftBins: number;
  shouldRebalance: boolean;
  shouldDeploy: boolean;
}

export class PositionEngine {
  private readonly config: BotConfig;
  private readonly rebalanceBuilder: RebalanceBuilder;
  private readonly logger: Logger;
  private state: PositionState = "NO_POSITION";

  constructor(config: BotConfig, rebalanceBuilder: RebalanceBuilder) {
    this.config = config;
    this.rebalanceBuilder = rebalanceBuilder;
    this.logger = Logger.getInstance();
  }

  public getState(): PositionState {
    return this.state;
  }

  public setState(state: PositionState): void {
    this.state = state;
  }

  public async evaluate(wallet: Keypair): Promise<PositionEvaluation> {
    const { activeBin, minBin, maxBin, hasPosition } =
      await this.rebalanceBuilder.getActiveBinAndPositionLimits(wallet);

    if (!hasPosition || minBin === null || maxBin === null) {
      this.state = "NO_POSITION";
      this.logger.info(`[POSITION] No active position on pool. Active bin: ${activeBin}`);
      return {
        state: "NO_POSITION",
        activeBin,
        minBin,
        maxBin,
        driftBins: 0,
        shouldRebalance: false,
        shouldDeploy: true,
      };
    }

    const positionCenter = Math.floor((minBin + maxBin) / 2);
    const driftBins = Math.abs(activeBin - positionCenter);
    const threshold = this.config.trading.driftThresholdBins;

    if (driftBins > threshold) {
      this.state = "DRIFT_DETECTED";
      this.logger.info(
        `[POSITION] Drift detected: activeBin=${activeBin}, center=${positionCenter}, drift=${driftBins} bins (threshold ${threshold})`
      );
      return {
        state: "DRIFT_DETECTED",
        activeBin,
        minBin,
        maxBin,
        driftBins,
        shouldRebalance: true,
        shouldDeploy: false,
      };
    }

    this.state = "IN_RANGE";
    this.logger.info(`[POSITION] In range. Drift ${driftBins} bins ≤ threshold ${threshold}. Holding.`);
    return {
      state: "IN_RANGE",
      activeBin,
      minBin,
      maxBin,
      driftBins,
      shouldRebalance: false,
      shouldDeploy: false,
    };
  }
}
