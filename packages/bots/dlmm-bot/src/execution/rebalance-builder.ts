import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, VersionedTransaction, TransactionMessage, TransactionInstruction } from "@solana/web3.js";
import DLMM, { StrategyType, autoFillYByStrategy, autoFillXByStrategy } from "@meteora-ag/dlmm";
import BN from "bn.js";
import { Logger } from "../utils/logger";
import { BotConfig } from "../types/config";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const SWAP_THRESHOLD = 1000;

export interface RebalanceTransaction {
  tx: Transaction | VersionedTransaction;
  signers: Keypair[];
}

export interface BuildResult {
  transactions: RebalanceTransaction[];
  warnings: string[];
}

export interface RebalanceBuildOptions {
  slippageBps?: number;
}

export class RebalanceBuilder {
  private readonly logger: Logger;
  private readonly targetPool: PublicKey;

  constructor(private readonly connection: Connection, private readonly config: BotConfig) {
    this.logger = Logger.getInstance();
    this.targetPool = new PublicKey(config.dlmm.targetPool);
  }

  public async getActiveBinAndPositionLimits(wallet: Keypair) {
    const dlmmPool = await DLMM.create(this.connection, this.targetPool);
    const activeBin = await dlmmPool.getActiveBin();
    const positions = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    
    let minBin: number | null = null;
    let maxBin: number | null = null;
    
    if (positions.userPositions.length > 0) {
      minBin = Math.min(...positions.userPositions.map((p) => p.positionData.lowerBinId));
      maxBin = Math.max(...positions.userPositions.map((p) => p.positionData.upperBinId));
    }
    
    return {
      activeBin: activeBin.binId,
      minBin,
      maxBin,
      hasPosition: positions.userPositions.length > 0,
    };
  }

  public async buildDeployTransactions(wallet: Keypair, options: RebalanceBuildOptions = {}): Promise<BuildResult> {
    const warnings: string[] = [];
    const dlmm = await DLMM.create(this.connection, this.targetPool);
    const activeBin = await dlmm.getActiveBin();
    
    const binCount = this.config.trading.strategyBinCount;
    const strategyType = this.config.dlmm.strategy;
    
    this.logger.info(`[STRATEGY] Building ${strategyType} initial deploy with ${binCount} bins around active bin ${activeBin.binId}`);
    
    const minBinId = activeBin.binId - Math.floor(binCount / 2);
    const maxBinId = activeBin.binId + Math.floor(binCount / 2);
    const slippageBps = options.slippageBps ?? this.config.trading.maxSlippageBps;
    
    let totalXAmount = await this.getTokenBalance(wallet, dlmm.tokenX.publicKey.toBase58());
    let totalYAmount = await this.getTokenBalance(wallet, dlmm.tokenY.publicKey.toBase58());
    
    if (this.config.trading.maxPositionSizeX !== undefined) {
      const maxTargetX = new BN(this.config.trading.maxPositionSizeX);
      if (totalXAmount.gt(maxTargetX)) {
        totalXAmount = maxTargetX;
      }
    }
    
    if (this.config.trading.maxPositionSizeY !== undefined) {
      const maxTargetY = new BN(this.config.trading.maxPositionSizeY);
      if (totalYAmount.gt(maxTargetY)) {
        totalYAmount = maxTargetY;
      }
    }
    
    this.logger.info("[STRATEGY] Cold start — deploying with current wallet balances (no swap)");
    warnings.push("deploy_no_swap: using wallet token ratio as-is");
    
    if (totalXAmount.isZero() && totalYAmount.isZero()) {
      throw new Error("[STRATEGY] No deployable token balance. Fund the wallet with pool tokens before deploying.");
    }
    
    const transactions = await this.assembleBundle(dlmm, wallet, [], [], totalXAmount, totalYAmount, minBinId, maxBinId, strategyType, slippageBps);
    return { transactions, warnings };
  }

  public async buildRebalanceTransactions(wallet: Keypair, options: RebalanceBuildOptions = {}): Promise<BuildResult> {
    const warnings: string[] = [];
    const dlmm = await DLMM.create(this.connection, this.targetPool);
    await dlmm.refetchStates();
    
    const activeBin = await dlmm.getActiveBin();
    const binCount = this.config.trading.strategyBinCount;
    const strategyType = this.config.dlmm.strategy;
    
    this.logger.info(`[STRATEGY] Building ${strategyType} rebalance with ${binCount} bins around active bin ${activeBin.binId}`);
    
    const minBinId = activeBin.binId - Math.floor(binCount / 2);
    const maxBinId = activeBin.binId + Math.floor(binCount / 2);
    const slippageBps = options.slippageBps ?? this.config.trading.maxSlippageBps;
    
    let totalXAmount = await this.getTokenBalance(wallet, dlmm.tokenX.publicKey.toBase58());
    let totalYAmount = await this.getTokenBalance(wallet, dlmm.tokenY.publicKey.toBase58());
    
    const { removeLiquidityTxs, totalXAmount: afterWithdrawX, totalYAmount: afterWithdrawY } = await this.withdrawAllPositions(dlmm, wallet, totalXAmount, totalYAmount);
    
    totalXAmount = afterWithdrawX;
    totalYAmount = afterWithdrawY;
    
    if (this.config.trading.maxPositionSizeX !== undefined) {
      const maxTargetX = new BN(this.config.trading.maxPositionSizeX);
      if (totalXAmount.gt(maxTargetX)) {
        this.logger.info(`[STRATEGY] Capping deployable Token X from ${totalXAmount.toString()} to max limit ${maxTargetX.toString()}`);
        totalXAmount = maxTargetX;
      }
    }
    
    if (this.config.trading.maxPositionSizeY !== undefined) {
      const maxTargetY = new BN(this.config.trading.maxPositionSizeY);
      if (totalYAmount.gt(maxTargetY)) {
        this.logger.info(`[STRATEGY] Capping deployable Token Y from ${totalYAmount.toString()} to max limit ${maxTargetY.toString()}`);
        totalYAmount = maxTargetY;
      }
    }
    
    const strategyEnum = this.resolveStrategyEnum(strategyType);
    const depositPlan = await this.computeBalancedDepositPlan(dlmm, activeBin, totalXAmount, totalYAmount, minBinId, maxBinId, strategyEnum);
    
    const swapResult = await this.buildMinimalStrategySwap(dlmm, wallet, depositPlan, slippageBps, warnings);
    
    const transactions = await this.assembleBundle(dlmm, wallet, removeLiquidityTxs, swapResult.swapTxs, swapResult.depositX, swapResult.depositY, minBinId, maxBinId, strategyType, slippageBps);
    return { transactions, warnings };
  }

  private async computeBalancedDepositPlan(dlmm: DLMM, activeBin: any, totalX: BN, totalY: BN, minBinId: number, maxBinId: number, strategyType: StrategyType) {
    const activeId = activeBin.binId;
    const binStep = dlmm.lbPair.binStep;
    const xInActive = activeBin.xAmount;
    const yInActive = activeBin.yAmount;
    
    const yForAllX = autoFillYByStrategy(activeId, binStep, totalX, xInActive, yInActive, minBinId, maxBinId, strategyType);
    const xForAllY = autoFillXByStrategy(activeId, binStep, totalY, xInActive, yInActive, minBinId, maxBinId, strategyType);
    
    this.logger.info(`[STRATEGY] autoFill — yForAllX=${yForAllX.toString()}, xForAllY=${xForAllY.toString()} (wallet X=${totalX.toString()}, Y=${totalY.toString()})`);

    const priceFloat = Number(activeBin.price);
    const decimalsX = await this.getMintDecimals((dlmm.lbPair as any).tokenXMint.toBase58());
    const decimalsY = await this.getMintDecimals((dlmm.lbPair as any).tokenYMint.toBase58());
    const scalingFactor = Math.pow(10, decimalsY - decimalsX);

    let plan: any;

    // DYNAMIC PROPORTION RECOVERY: Wallet holds 100% Token X, but pool demands a specific ratio of Token Y
    if (totalY.isZero() && !totalX.isZero() && yForAllX.gt(totalY)) {
      this.logger.warn("[STRATEGY] Single-sided Token X profile. Calculating dynamic proportional swapExactIn target...");
      const xValInYRaw = totalX.toNumber() * priceFloat * scalingFactor;
      const totalValInYRaw = xValInYRaw + yForAllX.toNumber();
      const swapFraction = yForAllX.toNumber() / totalValInYRaw;
      const swapInAmount = new BN(Math.floor(totalX.toNumber() * swapFraction));
      
      plan = {
        depositX: totalX.sub(swapInAmount),
        depositY: new BN(0),
        swap: { direction: "XtoY", isExactIn: true, inAmount: swapInAmount }
      };
    }

    // DYNAMIC PROPORTION RECOVERY: Wallet holds 100% Token Y, but pool demands Token X
    else if (totalX.isZero() && !totalY.isZero() && xForAllY.gt(totalX)) {
      this.logger.warn("[STRATEGY] Single-sided Token Y profile. Calculating dynamic proportional swapExactIn target...");
      const yValInXRaw = (totalY.toNumber() / priceFloat) / scalingFactor;
      const totalValInXRaw = yValInXRaw + xForAllY.toNumber();
      const swapFraction = xForAllY.toNumber() / totalValInXRaw;
      const swapInAmount = new BN(Math.floor(totalY.toNumber() * swapFraction));
      
      plan = {
        depositX: new BN(0),
        depositY: totalY.sub(swapInAmount),
        swap: { direction: "YtoX", isExactIn: true, inAmount: swapInAmount }
      };
    }
    
    else if (yForAllX.lte(totalY)) {
      plan = { depositX: totalX, depositY: yForAllX };
    }
    
    else if (xForAllY.lte(totalX)) {
      plan = { depositX: xForAllY, depositY: totalY };
    }
    
    else {
      const yDeficit = yForAllX.sub(totalY);
      const xDeficit = xForAllY.sub(totalX);
      
      if (yDeficit.lte(xDeficit)) {
        plan = {
          depositX: totalX,
          depositY: yForAllX,
          swap: { direction: "XtoY", isExactIn: false, outAmount: yDeficit },
        };
      } else {
        plan = {
          depositX: xForAllY,
          depositY: totalY,
          swap: { direction: "YtoX", isExactIn: false, outAmount: xDeficit },
        };
      }
    }
    
    plan.originalX = totalX;
    plan.originalY = totalY;
    return plan;
  }

  private async buildMinimalStrategySwap(dlmm: DLMM, wallet: Keypair, plan: any, slippageBps: number, warnings: string[]) {
    const isExactIn = plan.swap && plan.swap.isExactIn;
    const amount = isExactIn ? plan.swap.inAmount : (plan.swap ? plan.swap.outAmount : new BN(0));

    if (!plan.swap || amount.lte(new BN(SWAP_THRESHOLD))) {
      this.logger.info("[STRATEGY] Strategy-balanced deposit — no swap required");
      warnings.push("rebalance_no_swap: autoFill satisfied by wallet balances");
      return { swapTxs: [], depositX: plan.depositX, depositY: plan.depositY };
    }
    
    const { direction } = plan.swap;
    const swapForY = direction === "XtoY";
    this.logger.info(`[STRATEGY] Minimal ${direction} ${isExactIn ? "swapExactIn" : "swapExactOut"} for ${amount.toString()} lamports (Meteora autoFill)`);
    
    await dlmm.refetchStates();
    const binArrayCount = this.config.trading.swapBinArrayCount;
    const maxExtraBinArrays = this.config.trading.swapMaxExtraBinArrays;
    
    const binArrays = await dlmm.getBinArrayForSwap(swapForY, binArrayCount);
    let quote: any;
    
    try {
      if (isExactIn) {
        quote = dlmm.swapQuote(amount, swapForY, new BN(slippageBps), binArrays, false, maxExtraBinArrays);
      } else {
        quote = dlmm.swapQuoteExactOut(amount, swapForY, new BN(slippageBps), binArrays, maxExtraBinArrays);
      }
    } catch (error) {
      if (!this.isInsufficientLiquidityError(error)) {
        throw error;
      }
      
      this.logger.warn(`[STRATEGY] Swap quote failed with ${binArrayCount} bins. Trying with expanded search...`);
      const expandedBinArrays = await dlmm.getBinArrayForSwap(swapForY, binArrayCount * 2);
      try {
        if (isExactIn) {
          quote = dlmm.swapQuote(amount, swapForY, new BN(slippageBps), expandedBinArrays, false, maxExtraBinArrays);
        } else {
          quote = dlmm.swapQuoteExactOut(amount, swapForY, new BN(slippageBps), expandedBinArrays, maxExtraBinArrays);
        }
      } catch (error2) {
        if (!this.isInsufficientLiquidityError(error2)) {
          throw error2;
        }
        this.logger.warn(`[STRATEGY] Minimal strategy swap failed — pool lacks liquidity for ${amount.toString()} lamports. Proceeding with un-balanced deposit (no swap).`);
        warnings.push(`rebalance_swap_failed: insufficient liquidity, depositing original balances`);
        return { swapTxs: [], depositX: plan.originalX, depositY: plan.originalY };
      }
    }
    
    let swapTx;
    if (isExactIn) {
      swapTx = await dlmm.swap({
        inToken: swapForY ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey,
        outToken: swapForY ? dlmm.tokenY.publicKey : dlmm.tokenX.publicKey,
        inAmount: amount,
        minOutAmount: quote.minOutAmount,
        lbPair: dlmm.pubkey,
        user: wallet.publicKey,
        binArraysPubkey: quote.binArraysPubkey,
      });
      warnings.push(`minimal_swap_exact_in: direction=${direction} in=${amount.toString()} minOut=${quote.minOutAmount.toString()} binArrays=${quote.binArraysPubkey.length}`);
    } else {
      swapTx = await dlmm.swapExactOut({
        inToken: swapForY ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey,
        outToken: swapForY ? dlmm.tokenY.publicKey : dlmm.tokenX.publicKey,
        outAmount: amount,
        maxInAmount: quote.maxInAmount,
        lbPair: dlmm.pubkey,
        user: wallet.publicKey,
        binArraysPubkey: quote.binArraysPubkey,
      });
      warnings.push(`minimal_swap_exact_out: direction=${direction} out=${amount.toString()} maxIn=${quote.maxInAmount.toString()} binArrays=${quote.binArraysPubkey.length}`);
    }
    
    this.logger.info(`[STRATEGY] Post-swap deployable capital — TokenX: ${plan.depositX.toString()}, TokenY: ${plan.depositY.toString()}`);
    
    return { swapTxs: [swapTx], depositX: plan.depositX, depositY: plan.depositY };
  }

  private async withdrawAllPositions(dlmm: DLMM, wallet: Keypair, totalXAmount: BN, totalYAmount: BN) {
    const positionsResult = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
    const removeLiquidityTxs: Transaction[] = [];
    
    let x = totalXAmount;
    let y = totalYAmount;
    
    for (const pos of positionsResult.userPositions) {
      const posX = new BN(pos.positionData.totalXAmount.toString()).add(new BN(pos.positionData.feeX.toString()));
      const posY = new BN(pos.positionData.totalYAmount.toString()).add(new BN(pos.positionData.feeY.toString()));
      this.logger.info(`[STRATEGY] Withdrawing position ${pos.publicKey.toBase58()} — X: ${posX.toString()}, Y: ${posY.toString()}`);
      
      x = x.add(posX);
      y = y.add(posY);
      
      const removeTxs = await dlmm.removeLiquidity({
        position: pos.publicKey,
        user: wallet.publicKey,
        fromBinId: pos.positionData.lowerBinId,
        toBinId: pos.positionData.upperBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });
      
      if (Array.isArray(removeTxs)) {
        removeLiquidityTxs.push(...removeTxs as Transaction[]);
      } else {
        removeLiquidityTxs.push(removeTxs as Transaction);
      }
    }
    return { removeLiquidityTxs, totalXAmount: x, totalYAmount: y };
  }

  private async assembleBundle(dlmm: DLMM, wallet: Keypair, removeLiquidityTxs: Transaction[], swapTxs: Transaction[], balancedX: BN, balancedY: BN, minBinId: number, maxBinId: number, strategyType: string, slippageBps: number) {
    if (balancedX.isZero() && balancedY.isZero()) {
      throw new Error("[STRATEGY] No deployable token balance after rebalance steps.");
    }
    
    this.logger.info(`[STRATEGY] Deployable capital — TokenX: ${balancedX.toString()}, TokenY: ${balancedY.toString()}`);
    
    const slippagePercentage = slippageBps / 100;
    const numerator = new BN(100);
    const denominator = new BN(Math.ceil(100 + slippagePercentage));
    
    const safeTotalXAmount = balancedX.mul(numerator).div(denominator);
    const safeTotalYAmount = balancedY.mul(numerator).div(denominator);
    
    const strategyParams = this.resolveStrategyParams(strategyType, minBinId, maxBinId);
    const newPositionKeypair = Keypair.generate();
    
    const addLiquidityTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPositionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: safeTotalXAmount,
      totalYAmount: safeTotalYAmount,
      strategy: strategyParams,
      slippage: slippagePercentage,
    });
    
    const addTxs = Array.isArray(addLiquidityTx) ? addLiquidityTx : [addLiquidityTx];
    const { blockhash } = await this.connection.getLatestBlockhash("processed");
    
    const result: { tx: Transaction, signers: Keypair[] }[] = [];
    
    for (const tx of removeLiquidityTxs) {
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      result.push({ tx, signers: [wallet] });
    }
    
    for (const tx of swapTxs) {
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      result.push({ tx, signers: [wallet] });
    }
    
    for (const tx of addTxs) {
      const addTx = tx as Transaction;
      addTx.recentBlockhash = blockhash;
      addTx.feePayer = wallet.publicKey;
      result.push({ tx: addTx, signers: [wallet, newPositionKeypair] });
    }
    
    return result;
  }

  private resolveStrategyEnum(strategyType: string): StrategyType {
    if (strategyType === "Spot") return StrategyType.Spot;
    if (strategyType === "BidAsk") return StrategyType.BidAsk;
    return StrategyType.Curve;
  }

  private resolveStrategyParams(strategyType: string, minBinId: number, maxBinId: number) {
    if (strategyType === "Spot") {
      return { maxBinId, minBinId, strategyType: StrategyType.Spot };
    }
    if (strategyType === "BidAsk") {
      return { maxBinId, minBinId, strategyType: StrategyType.BidAsk };
    }
    return { maxBinId, minBinId, strategyType: StrategyType.Curve };
  }

  private async getTokenBalance(wallet: Keypair, mint: string): Promise<BN> {
    if (mint === WSOL_MINT) {
      const solBalance = await this.connection.getBalance(wallet.publicKey);
      const buffer = this.config.trading.solRentBuffer * 1e9;
      return new BN(Math.max(0, solBalance - buffer));
    }
    
    const parsedAccounts = await this.connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(mint),
    });
    
    if (parsedAccounts.value.length > 0) {
      return new BN(parsedAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
    }
    
    return new BN(0);
  }

  private async getMintDecimals(mint: string): Promise<number> {
    if (mint === WSOL_MINT) return 9;
    const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
    if (info.value && 'parsed' in info.value.data) {
      return (info.value.data as any).parsed.info.decimals;
    }
    throw new Error(`Could not fetch decimals for ${mint}`);
  }

  private isInsufficientLiquidityError(error: any): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("SWAP_QUOTE_INSUFFICIENT_LIQUIDITY") || message.includes("Insufficient liquidity");
  }

  private prepareTransaction(tx: Transaction, wallet: Keypair, signers: Keypair[], blockhash: string): RebalanceTransaction {
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    
    const optimizedTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
    tx.instructions.forEach((ix) => {
      if (!ix.programId.equals(ComputeBudgetProgram.programId)) {
        optimizedTx.add(ix);
      }
    });
    
    optimizedTx.recentBlockhash = blockhash;
    optimizedTx.feePayer = wallet.publicKey;
    return { tx: optimizedTx, signers };
  }
}
