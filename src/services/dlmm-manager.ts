import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import { ConfigManager } from '../utils/config';
import { Logger } from '../utils/logger';
import { BotConfig } from '../types/config';
import { TransactionSimulator } from './transaction-simulator';

export class DlmmManager {
  private connection: Connection;
  private config: BotConfig;
  private logger: Logger;
  private targetPool: PublicKey;

  constructor(connection: Connection) {
    this.connection = connection;
    this.config = ConfigManager.getInstance().getConfig();
    this.logger = Logger.getInstance();
    this.targetPool = new PublicKey(this.config.dlmm.targetPool);
  }

  public async checkAndInitializePosition(wallet: Keypair): Promise<Transaction | null> {
    try {
      this.logger.info(`Checking active positions for wallet: ${wallet.publicKey.toBase58()}`);
      const dlmmPool = await DLMM.create(this.connection, this.targetPool);
      const positions = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);

      if (positions && positions.activeBin && positions.userPositions.length > 0) {
        this.logger.success(`Found ${positions.userPositions.length} active positions. Proceeding to monitor.`);
        return null;
      }

      this.logger.info(`No active positions found. Handing control to the Continuous Evaluation Loop for immediate cold-start deployment.`);
      return null;
    } catch (error) {
      this.logger.error(`Error in DLMM position checking: ${error}`);
      throw error;
    }
  }

  public async calculateRebalanceStrategy(wallet: Keypair, strategyType: "Spot" | "Curve" | "BidAsk", binCount: number): Promise<Transaction[]> {
    try {
      const poolAddress = new PublicKey(this.config.dlmm.targetPool);
      const dlmm = await DLMM.create(this.connection, poolAddress);
      const activeBin = await dlmm.getActiveBin();

      console.log(`[STRATEGY] Real SDK Engine calculating ${strategyType} strategy with ${binCount} bins around active bin ${activeBin.binId}`);

      const minBinId = activeBin.binId - Math.floor(binCount / 2);
      const maxBinId = activeBin.binId + Math.floor(binCount / 2);

      const wsolMint = "So11111111111111111111111111111111111111112";
      let totalXAmount = new BN(0);
      let totalYAmount = new BN(0);

      const xMint = dlmm.tokenX.publicKey.toBase58();
      const yMint = dlmm.tokenY.publicKey.toBase58();

      const getBalanceOrWsol = async (mint: string) => {
        if (mint === wsolMint) {
          const solBalance = await this.connection.getBalance(wallet.publicKey);
          const buffer = 0.15 * 1e9; // 0.15 SOL buffer for priority fees and rent
          return new BN(Math.max(0, solBalance - buffer));
        } else {
          const parsedAccounts = await this.connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
          if (parsedAccounts.value.length > 0) {
            return new BN(parsedAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
          }
          return new BN(0);
        }
      };

      totalXAmount = await getBalanceOrWsol(xMint);
      totalYAmount = await getBalanceOrWsol(yMint);

      console.log(`[STRATEGY] Initial Wallet Balances - TokenX: ${totalXAmount.toString()}, TokenY: ${totalYAmount.toString()}`);
      
      // SWAPLESS REBALANCING: Fetch existing positions to withdraw liquidity
      const positionsResult = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
      const userPositions = positionsResult.userPositions;
      
      const removeLiquidityTxs: Transaction[] = [];

      for (const pos of userPositions) {
        // Calculate the amounts we are withdrawing to add to our deployment capital
        const posX = (new BN(pos.positionData.totalXAmount.toString()) as any).add(new BN(pos.positionData.feeX.toString()));
        const posY = (new BN(pos.positionData.totalYAmount.toString()) as any).add(new BN(pos.positionData.feeY.toString()));
        
        console.log(`[STRATEGY] Withdrawing from Position ${pos.publicKey.toBase58()}: TokenX: ${posX.toString()}, TokenY: ${posY.toString()}`);
        
        // Add withdrawn amounts to total available capital
        totalXAmount = (totalXAmount as any).add(posX);
        totalYAmount = (totalYAmount as any).add(posY);

        // Generate removeLiquidity instruction
        const removeTxs = await dlmm.removeLiquidity({
          position: pos.publicKey,
          user: wallet.publicKey,
          fromBinId: pos.positionData.lowerBinId,
          toBinId: pos.positionData.upperBinId,
          bps: new BN(10000), // 100% removal
          shouldClaimAndClose: true, // Claim fees and close account to reclaim rent
        });
        
        if (Array.isArray(removeTxs)) {
          removeLiquidityTxs.push(...removeTxs);
        } else {
          removeLiquidityTxs.push(removeTxs);
        }
      }

      console.log(`[STRATEGY] Total Deployable Capital (Wallet + Withdrawn) - TokenX: ${totalXAmount.toString()}, TokenY: ${totalYAmount.toString()}`);
      
      let strategyParams;
      if (strategyType === "Spot") {
        strategyParams = { maxBinId, minBinId, strategyType: StrategyType.Spot };
      } else if (strategyType === "Curve") {
        strategyParams = { maxBinId, minBinId, strategyType: StrategyType.Curve };
      } else {
        strategyParams = { maxBinId, minBinId, strategyType: StrategyType.BidAsk };
      }

      // We wrap the instruction in a transaction
      const newPositionKeypair = Keypair.generate();
      const slippagePercentage = this.config.trading.maxSlippageBps / 100;
      
      const addLiquidityTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPositionKeypair.publicKey,
        user: wallet.publicKey,
        totalXAmount,
        totalYAmount,
        strategy: strategyParams,
        slippage: slippagePercentage,
      });

      const addTxs = Array.isArray(addLiquidityTx) ? addLiquidityTx : [addLiquidityTx];
      
      // Fetch newest blockhash to use for all transactions in the bundle
      const { blockhash } = await this.connection.getLatestBlockhash();
      const simulator = new TransactionSimulator(this.connection, this.config);
      
      const optimizedRemoveTxs: Transaction[] = [];
      const optimizedAddTxs: Transaction[] = [];
      
      // Simulate and sign remove transactions (only requires wallet)
      for (let i = 0; i < removeLiquidityTxs.length; i++) {
        const tx = removeLiquidityTxs[i];
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        
        const res = await simulator.simulateAndOptimize(tx, wallet, []);
        if (!res.success || !res.optimizedTransaction) {
           throw new Error(`[SIMULATION] Remove liquidity simulation failed: ${res.error}`);
        }
        optimizedRemoveTxs.push(res.optimizedTransaction);
      }

      // Simulate and sign add transactions (requires wallet AND ephemeral position keypair)
      for (let i = 0; i < addTxs.length; i++) {
        const tx = addTxs[i];
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        
        const res = await simulator.simulateAndOptimize(tx, wallet, [newPositionKeypair]);
        if (!res.success || !res.optimizedTransaction) {
           throw new Error(`[SIMULATION] Add liquidity simulation failed: ${res.error}`);
        }
        optimizedAddTxs.push(res.optimizedTransaction);
      }

      // Return sequentially: Withdrawals FIRST, then Deployment
      return [...optimizedRemoveTxs, ...optimizedAddTxs];
    } catch (error) {
      console.error("[STRATEGY] Error calculating rebalance strategy:", error);
      throw error;
    }
  }

  public async getActiveBinAndPositionLimits(wallet: Keypair): Promise<{ activeBin: number, minBin: number | null, maxBin: number | null }> {
    try {
      const dlmmPool = await DLMM.create(this.connection, this.targetPool);
      const activeBin = await dlmmPool.getActiveBin();
      
      const positions = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      let minBin: number | null = null;
      let maxBin: number | null = null;

      if (positions && positions.userPositions.length > 0) {
        minBin = Math.min(...positions.userPositions.map(p => p.positionData.lowerBinId));
        maxBin = Math.max(...positions.userPositions.map(p => p.positionData.upperBinId));
      }

      return {
        activeBin: activeBin.binId,
        minBin,
        maxBin
      };
    } catch (error) {
      console.error(`Error fetching bin limits: ${error}`);
      return { activeBin: 0, minBin: null, maxBin: null };
    }
  }
}
