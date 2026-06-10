import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import BN from "bn.js";
import { PoolAccounts, BotConfig } from "../types/config";

export class MeteoraTransactionBuilder {
  private meteoraProgramId: PublicKey;
  private config: BotConfig;

  constructor(meteoraProgramId: string, config: BotConfig) {
    this.meteoraProgramId = new PublicKey(meteoraProgramId);
    this.config = config;
  }

  public async buildBuyTransaction(
    wallet: Keypair,
    poolAccounts: PoolAccounts,
    amountIn: number,
    walletBalance?: number
  ): Promise<Transaction> {
    const transaction = new Transaction();
    
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.config.trading.priorityFeeMicroLamports,
      })
    );

    // Calculate amount to use - either percentage of balance or fixed amount
    let lamportsIn: number;
    if (this.config.trading.usePercentageOfBalance && walletBalance !== undefined) {
      const reservedForFees = 0.01 * LAMPORTS_PER_SOL; // Reserve 0.01 SOL for transaction fees
      const availableBalance = Math.max(0, walletBalance - reservedForFees);
      lamportsIn = Math.floor((availableBalance * this.config.trading.balancePercentage) / 100);
      console.log(` Using ${this.config.trading.balancePercentage}% of balance: ${lamportsIn / LAMPORTS_PER_SOL} SOL`);
    } else {
      lamportsIn = Math.floor(amountIn * LAMPORTS_PER_SOL);
      console.log(` Using fixed amount: ${lamportsIn / LAMPORTS_PER_SOL} SOL`);
    }
    const userTokenAccountA = await getAssociatedTokenAddress(
      new PublicKey(poolAccounts.tokenMintA),
      wallet.publicKey
    );
    const userTokenAccountB = await getAssociatedTokenAddress(
      new PublicKey(poolAccounts.tokenMintB),
      wallet.publicKey
    );
    const userWsolAccount = await getAssociatedTokenAddress(
      NATIVE_MINT,
      wallet.publicKey
    );

    transaction.add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        userWsolAccount,
        wallet.publicKey,
        NATIVE_MINT
      )
    );

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: userWsolAccount,
        lamports: lamportsIn,
      })
    );

    transaction.add(
      createSyncNativeInstruction(userWsolAccount)
    );

    const isTokenASOL = poolAccounts.tokenMintA === NATIVE_MINT.toString();
    const isTokenBSOL = poolAccounts.tokenMintB === NATIVE_MINT.toString();
    
    if (!isTokenASOL) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          userTokenAccountA,
          wallet.publicKey,
          new PublicKey(poolAccounts.tokenMintA)
        )
      );
    }

    if (!isTokenBSOL) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          userTokenAccountB,
          wallet.publicKey,
          new PublicKey(poolAccounts.tokenMintB)
        )
      );
    }

    const swapInstruction = this.createSwapInstruction(
      wallet.publicKey,
      poolAccounts,
      lamportsIn,
      isTokenASOL ? userWsolAccount : userTokenAccountA,
      isTokenBSOL ? userWsolAccount : userTokenAccountB
    );

    transaction.add(swapInstruction);

    // Close the WSOL account to reclaim rent after the swap
    transaction.add(
      createCloseAccountInstruction(
        userWsolAccount,
        wallet.publicKey, // destination for remaining lamports
        wallet.publicKey  // owner
      )
    );

    return transaction;
  }

  private createSwapInstruction(
    userPublicKey: PublicKey,
    poolAccounts: PoolAccounts,
    amountIn: number,
    userTokenAccountA: PublicKey,
    userTokenAccountB: PublicKey
  ): TransactionInstruction {
    const minAmountOut = 0;
    const sqrtPriceLimitX64 = new BN(0);
    
    const accounts = [
      { pubkey: new PublicKey(poolAccounts.pool), isSigner: false, isWritable: true },
      { pubkey: userTokenAccountA, isSigner: false, isWritable: true },
      { pubkey: userTokenAccountB, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(poolAccounts.aVault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(poolAccounts.bVault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(poolAccounts.aTokenVault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(poolAccounts.bTokenVault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(poolAccounts.aVaultLpMint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(poolAccounts.bVaultLpMint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(poolAccounts.aVaultLp), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(poolAccounts.bVaultLp), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(poolAccounts.protocolTokenFee), isSigner: false, isWritable: true },
      { pubkey: userPublicKey, isSigner: false, isWritable: true }, // adminTokenFee placeholder
      { pubkey: new PublicKey("24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi"), isSigner: false, isWritable: false }, // vaultProgram placeholder
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      // { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
    ];

    const data = this.encodeSwapData(amountIn, minAmountOut, sqrtPriceLimitX64, true, true);

    return new TransactionInstruction({
      keys: accounts,
      programId: this.meteoraProgramId,
      data: data,
    });
  }

  private encodeSwapData(
    amountIn: number,
    minAmountOut: number,
    sqrtPriceLimitX64: BN,
    amountSpecifiedIsInput: boolean,
    aToB: boolean
  ): Buffer {
    // Meteora swap instruction format: [instruction_discriminator, in_amount, minimum_out_amount]
    // Discriminator from IDL: [248, 198, 158, 145, 225, 117, 135, 200]
    const discriminator = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);

    const inAmountBuffer = Buffer.alloc(8);
    inAmountBuffer.writeBigUInt64LE(BigInt(amountIn), 0);

    const minimumOutAmountBuffer = Buffer.alloc(8);
    minimumOutAmountBuffer.writeBigUInt64LE(BigInt(minAmountOut), 0);

    return Buffer.concat([
      discriminator,
      inAmountBuffer,
      minimumOutAmountBuffer,
    ]);
  }

  public calculateMinAmountOut(amountIn: number, slippageBps: number): number {
    const slippagePercent = slippageBps / 10000;
    return Math.floor(amountIn * (1 - slippagePercent));
  }
}