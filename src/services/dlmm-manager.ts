import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import { BN } from '@coral-xyz/anchor';
import { ConfigManager } from '../utils/config';
import { Logger } from '../utils/logger';
import { BotConfig } from '../types/config';
import { AiStrategyAgent, PoolConditions } from './ai-strategy-agent';

export class DlmmManager {
  private connection: Connection;
  private config: BotConfig;
  private logger: Logger;
  private targetPool: PublicKey;
  private strategyAgent: AiStrategyAgent;

  constructor(connection: Connection) {
    this.connection = connection;
    this.config = ConfigManager.getInstance().getConfig();
    this.logger = Logger.getInstance();
    this.targetPool = new PublicKey(this.config.dlmm.targetPool);
    this.strategyAgent = new AiStrategyAgent();
  }

  /**
   * Checks if the given wallet has an active LP position in the target pool.
   * If not, it calculates and returns an initial provisioning transaction.
   */
  public async checkAndInitializePosition(wallet: Keypair): Promise<Transaction | null> {
    try {
      this.logger.info(`Checking active positions for wallet: ${wallet.publicKey.toBase58()}`);

      const dlmmPool = await DLMM.create(this.connection, this.targetPool);
      
      const positions = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);

      if (positions && positions.activeBin && positions.userPositions.length > 0) {
        this.logger.success(`Found ${positions.userPositions.length} active positions. Proceeding to monitor.`);
        return null;
      }

      this.logger.info(`No active positions found. Provisioning initial liquidity...`);

      // We assume neutral conditions for the very first initialization, 
      // but in a live scenario the orchestrator would pass tracked conditions.
      const initialConditions: PoolConditions = {
        volatility: "Medium",
        trend: "Neutral",
        recentSwapCount: 0,
        averageSwapSizeSol: 0
      };

      return await this.openInitialPosition(dlmmPool, wallet, initialConditions);

    } catch (error) {
      this.logger.error(`Error in DLMM position checking: ${error}`);
      throw error;
    }
  }

  /**
   * Opens an initial position around the active bin using AI Strategy
   */
  private async openInitialPosition(dlmmPool: DLMM, wallet: Keypair, conditions: PoolConditions): Promise<Transaction | null> {
    const activeBin = await dlmmPool.getActiveBin();
    this.logger.info(`Current active bin is: ${activeBin.binId}`);

    // Consult AI for optimal strategy and bin intervals
    const strategy = await this.strategyAgent.determineOptimalStrategy(conditions);

    const minBinId = activeBin.binId + strategy.minBinOffset;
    const maxBinId = activeBin.binId + strategy.maxBinOffset;

    // Use amount from config for initial provisioning (example amounts, should be adjusted based on decimals)
    // NOTE: For a real production app, token decimals and actual balances must be considered.
    // Here we use tradeAmountSol as a base metric for provisioning.
    const amountToProvision = new BN(this.config.trading.tradeAmountSol * 1e9);

    // In a real scenario we'd define X and Y amounts based on the pool's tokens. 
    // We assume the user has the required tokens.
    const newPosition = Keypair.generate();

    this.logger.info(`Building Add Liquidity transaction for bins [${minBinId}, ${maxBinId}]`);

    try {
      const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: amountToProvision,
        totalYAmount: amountToProvision, // Simplification for MVP
        strategy: {
          maxBinId,
          minBinId,
          strategyType: strategy.strategyType,
        },
      });

      // We return the transaction to the Orchestrator for sending via Jito with the AI tip
      this.logger.success(`Transaction built for opening new position: ${newPosition.publicKey.toBase58()}`);

      return createPositionTx;

    } catch (error) {
      this.logger.error(`Failed to build initial position transaction: ${error}`);
      return null;
    }
  }
}
