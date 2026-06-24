import { PublicKey } from "@solana/web3.js";

export interface MeteoraSwapInstruction {
  amount: string;
  otherAmountThreshold: string;
  sqrtPriceLimitX64: string;
  amountSpecifiedIsInput: boolean;
  aToB: boolean;
}

export interface ParsedMeteoraTransaction {
  instructions: any[];
  poolAccounts: {
    pool: PublicKey;
    tokenMintA: PublicKey;
    tokenMintB: PublicKey;
    aTokenVault: PublicKey;
    bTokenVault: PublicKey;
    aVaultLp: PublicKey;
    bVaultLp: PublicKey;
    aVaultLpMint: PublicKey;
    bVaultLpMint: PublicKey;
    ammConfig: PublicKey;
    observationState: PublicKey;
  };
}

export interface MeteoraPoolCreationData {
  tokenMintA: string;
  tokenMintB: string;
  tickSpacing: number;
  sqrtPriceX64: string;
  protocolFeesTokenA: string;
  protocolFeesTokenB: string;
  swapFeesTokenA: string;
  swapFeesTokenB: string;
}