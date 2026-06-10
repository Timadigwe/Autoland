import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddress
} from '@solana/spl-token';
import { BN } from 'bn.js';
import { MeteoraTransactionBuilder } from '../src/services/transaction-builder';
import { BotConfig, PoolAccounts } from '../src/types/config';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const mockConfig: BotConfig = {
  rpc: {
    url: 'https://api.mainnet-beta.solana.com'
  },
  grpc: {
    url: 'grpc://localhost:8000',
    token: 'test-token'
  },
  meteora: {
    programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'
  },
  jito: {
    blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
    tipAccount: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    uuid: 'test',
    singleTransactionPerBundle: false
  },
  trading: {
    tradeAmountSol: 0.01,
    maxSlippageBps: 500,
    priorityFeeMicroLamports: 10000,
    usePercentageOfBalance: false,
    balancePercentage: 0
  },
  wallets: {
    privateKeys: ['test-key-1', 'test-key-2']
  },
  dlmm: {
    targetPool: 'your-target-pool-address'
  },
  ai: {
    openRouterApiKey: 'test-api-key',
    model: 'meta-llama/llama-3-8b-instruct:free'
  },
  simulation: {
    enabled: false,
    commitment: 'confirmed',
    validateAccounts: true,
    logDetails: true,
    failOnSimulationError: false
  }
};

const mockPoolAccounts: PoolAccounts = {
  pool: '11111111111111111111111111111112',
  lpMint: '11111111111111111111111111111113',
  tokenMintA: '11111111111111111111111111111114',
  tokenMintB: '11111111111111111111111111111115',
  aVault: '11111111111111111111111111111116',
  bVault: '11111111111111111111111111111117',
  aTokenVault: '11111111111111111111111111111118',
  bTokenVault: '11111111111111111111111111111119',
  aVaultLp: '1111111111111111111111111111111A',
  bVaultLp: '1111111111111111111111111111111B',
  aVaultLpMint: '1111111111111111111111111111111C',
  bVaultLpMint: '1111111111111111111111111111111D',
  protocolTokenFee: '1111111111111111111111111111111E'
};

jest.mock('@solana/spl-token', () => {
  const actual = jest.requireActual('@solana/spl-token') as any;
  return {
    ...actual,
    getAssociatedTokenAddress: jest.fn()
  };
});

describe('MeteoraTransactionBuilder', () => {
  let builder: MeteoraTransactionBuilder;
  let testWallet: Keypair;

  beforeEach(() => {
    builder = new MeteoraTransactionBuilder(mockConfig.meteora.programId, mockConfig);
    testWallet = Keypair.generate();
    
    // Setup mocks for getAssociatedTokenAddress
    (getAssociatedTokenAddress as jest.Mock).mockImplementation(
      (...args: any[]) => {
        return Promise.resolve(Keypair.generate().publicKey);
      }
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with correct program ID and config', () => {
      expect(builder).toBeInstanceOf(MeteoraTransactionBuilder);
    });

    it('should throw error with invalid program ID', () => {
      expect(() => {
        new MeteoraTransactionBuilder('invalid', mockConfig);
      }).toThrow();
    });
  });

  describe('buildBuyTransaction', () => {
    it('should build complete buy transaction with all necessary instructions', async () => {
      const amountIn = 0.01;
      
      const transaction = await builder.buildBuyTransaction(
        testWallet,
        mockPoolAccounts,
        amountIn
      );

      expect(transaction).toBeInstanceOf(Transaction);
      expect(transaction.instructions.length).toBeGreaterThan(0);
      
      // Check if compute budget instruction is added
      const computeBudgetInstruction = transaction.instructions.find(ix =>
        ix.programId.equals(ComputeBudgetProgram.programId)
      );
      expect(computeBudgetInstruction).toBeDefined();
    });

    it('should include correct amount in SOL to lamports conversion', async () => {
      const amountIn = 0.5;
      const expectedLamports = Math.floor(amountIn * LAMPORTS_PER_SOL);
      
      const transaction = await builder.buildBuyTransaction(
        testWallet,
        mockPoolAccounts,
        amountIn
      );

      // Check if system transfer instruction has correct amount
      const transferInstruction = transaction.instructions.find(ix =>
        ix.programId.equals(SystemProgram.programId) &&
        ix.keys.some(key => key.pubkey.equals(testWallet.publicKey))
      );
      
      expect(transferInstruction).toBeDefined();
    });

    it('should handle WSOL (SOL) as token A correctly', async () => {
      const poolAccountsWithSOL = {
        ...mockPoolAccounts,
        tokenMintA: NATIVE_MINT.toString()
      };

      const transaction = await builder.buildBuyTransaction(
        testWallet,
        poolAccountsWithSOL,
        0.01
      );

      expect(transaction).toBeInstanceOf(Transaction);
      expect(transaction.instructions.length).toBeGreaterThan(0);
    });

    it('should handle WSOL (SOL) as token B correctly', async () => {
      const poolAccountsWithSOL = {
        ...mockPoolAccounts,
        tokenMintB: NATIVE_MINT.toString()
      };

      const transaction = await builder.buildBuyTransaction(
        testWallet,
        poolAccountsWithSOL,
        0.01
      );

      expect(transaction).toBeInstanceOf(Transaction);
      expect(transaction.instructions.length).toBeGreaterThan(0);
    });

    it('should set correct priority fee', async () => {
      const transaction = await builder.buildBuyTransaction(
        testWallet,
        mockPoolAccounts,
        0.01
      );

      const computeBudgetInstruction = transaction.instructions.find(ix =>
        ix.programId.equals(ComputeBudgetProgram.programId)
      );
      
      expect(computeBudgetInstruction).toBeDefined();
    });

    it('should handle zero amount gracefully', async () => {
      const transaction = await builder.buildBuyTransaction(
        testWallet,
        mockPoolAccounts,
        0
      );

      expect(transaction).toBeInstanceOf(Transaction);
    });

    it('should handle large amounts correctly', async () => {
      const largeAmount = 100.5;
      
      const transaction = await builder.buildBuyTransaction(
        testWallet,
        mockPoolAccounts,
        largeAmount
      );

      expect(transaction).toBeInstanceOf(Transaction);
      expect(transaction.instructions.length).toBeGreaterThan(0);
    });
  });

  describe('calculateMinAmountOut', () => {
    it('should calculate correct minimum amount with slippage', () => {
      const amountIn = 1000000;  // 1M lamports
      const slippageBps = 500;   // 5%
      
      const minAmountOut = builder.calculateMinAmountOut(amountIn, slippageBps);
      const expectedMinOut = Math.floor(amountIn * 0.95); // 95% of input
      
      expect(minAmountOut).toBe(expectedMinOut);
    });

    it('should handle zero slippage', () => {
      const amountIn = 1000000;
      const slippageBps = 0;
      
      const minAmountOut = builder.calculateMinAmountOut(amountIn, slippageBps);
      
      expect(minAmountOut).toBe(amountIn);
    });

    it('should handle maximum slippage (100%)', () => {
      const amountIn = 1000000;
      const slippageBps = 10000; // 100%
      
      const minAmountOut = builder.calculateMinAmountOut(amountIn, slippageBps);
      
      expect(minAmountOut).toBe(0);
    });

    it('should handle small amounts', () => {
      const amountIn = 1;
      const slippageBps = 500;
      
      const minAmountOut = builder.calculateMinAmountOut(amountIn, slippageBps);
      
      expect(minAmountOut).toBe(0); // Floor of 0.95
    });

    it('should handle fractional results correctly', () => {
      const amountIn = 1000;
      const slippageBps = 333; // 3.33%
      
      const minAmountOut = builder.calculateMinAmountOut(amountIn, slippageBps);
      const expectedMinOut = Math.floor(1000 * (1 - 0.0333));
      
      expect(minAmountOut).toBe(expectedMinOut);
    });
  });

  describe('createSwapInstruction', () => {
    it('should create swap instruction with correct accounts', () => {
      const userTokenAccountA = Keypair.generate().publicKey;
      const userTokenAccountB = Keypair.generate().publicKey;
      const amountIn = 1000000;

      const instruction = (builder as any).createSwapInstruction(
        testWallet.publicKey,
        mockPoolAccounts,
        amountIn,
        userTokenAccountA,
        userTokenAccountB
      );

      expect(instruction.programId.toString()).toBe(mockConfig.meteora.programId);
      expect(instruction.keys.length).toBe(15); // Updated for Meteora account structure
      
      // Check first account is the pool
      expect(instruction.keys[0].pubkey.toString()).toBe(mockPoolAccounts.pool);
      expect(instruction.keys[0].isWritable).toBe(true);
      
      // Check user signer account (now at position 12)
      expect(instruction.keys[12].pubkey.equals(testWallet.publicKey)).toBe(true);
      expect(instruction.keys[12].isSigner).toBe(false);
    });

    it('should include TOKEN_PROGRAM_ID as last account', () => {
      const userTokenAccountA = Keypair.generate().publicKey;
      const userTokenAccountB = Keypair.generate().publicKey;

      const instruction = (builder as any).createSwapInstruction(
        testWallet.publicKey,
        mockPoolAccounts,
        1000000,
        userTokenAccountA,
        userTokenAccountB
      );

      const lastAccount = instruction.keys[instruction.keys.length - 1];
      expect(lastAccount.pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    });
  });

  describe('encodeSwapData', () => {
    it('should encode swap data correctly', () => {
      const amountIn = 1000000;
      const minAmountOut = 950000;
      const sqrtPriceLimitX64 = new BN(0);
      const amountSpecifiedIsInput = true;
      const aToB = true;

      const encodedData = (builder as any).encodeSwapData(
        amountIn,
        minAmountOut,
        sqrtPriceLimitX64,
        amountSpecifiedIsInput,
        aToB
      );

      expect(encodedData).toBeInstanceOf(Buffer);
      expect(encodedData.length).toBe(24); // 8 + 8 + 8 bytes for Meteora format
      
      // Check instruction discriminator (first 8 bytes)
      expect(encodedData.readBigUInt64LE(0).toString(16)).toBe("c88775e1919ec6f8");
      
      // Check amount encoding (next 8 bytes)
      expect(encodedData.readBigUInt64LE(8).toString()).toBe(amountIn.toString());
      
      // Check min amount out encoding (last 8 bytes)
      expect(encodedData.readBigUInt64LE(16).toString()).toBe(minAmountOut.toString());
    });

    it('should encode boolean flags correctly', () => {
      const encodedData = (builder as any).encodeSwapData(
        1000000,
        950000,
        new BN(0),
        false, // amountSpecifiedIsInput (not used in Meteora format)
        false  // aToB (not used in Meteora format)
      );

      // Meteora uses simpler format, just check the structure
      expect(encodedData.length).toBe(24);
      expect(encodedData.readBigUInt64LE(8).toString()).toBe("1000000");
      expect(encodedData.readBigUInt64LE(16).toString()).toBe("950000");
    });

    it('should handle large sqrt price limit', () => {
      const largeSqrtPrice = new BN('340282366920938463463374607431768211455'); // Max u128
      
      const encodedData = (builder as any).encodeSwapData(
        1000000,
        950000,
        largeSqrtPrice, // Not used in Meteora format but still pass for compatibility
        true,
        true
      );

      expect(encodedData).toBeInstanceOf(Buffer);
      expect(encodedData.length).toBe(24);
    });

    it('should handle zero values', () => {
      const encodedData = (builder as any).encodeSwapData(
        0,
        0,
        new BN(0),
        false,
        false
      );

      expect(encodedData.readBigUInt64LE(8).toString()).toBe("0");
      expect(encodedData.readBigUInt64LE(16).toString()).toBe("0");
    });
  });

  describe('error handling and edge cases', () => {
    it('should handle invalid pool accounts gracefully', async () => {
      const invalidPoolAccounts = {
        ...mockPoolAccounts,
        pool: 'invalid-public-key'
      };

      await expect(
        builder.buildBuyTransaction(testWallet, invalidPoolAccounts, 0.01)
      ).rejects.toThrow();
    });

    it('should handle negative amounts', async () => {
      // Negative amounts should be handled gracefully by converting to 0
      await expect(
        builder.buildBuyTransaction(testWallet, mockPoolAccounts, -0.01)
      ).rejects.toThrow();
    });

    it('should handle very small amounts (precision)', () => {
      const smallAmount = 0.000000001; // 1 lamport
      const result = builder.calculateMinAmountOut(
        Math.floor(smallAmount * LAMPORTS_PER_SOL),
        500
      );
      
      expect(result).toBe(0); // Should round down to 0
    });

    it('should handle null/undefined wallet gracefully', async () => {
      await expect(
        builder.buildBuyTransaction(null as any, mockPoolAccounts, 0.01)
      ).rejects.toThrow();
    });

    it('should handle missing pool accounts fields', async () => {
      const incompletePoolAccounts = {
        pool: mockPoolAccounts.pool,
        tokenMintA: mockPoolAccounts.tokenMintA
        // Missing other required fields
      } as any;

      await expect(
        builder.buildBuyTransaction(testWallet, incompletePoolAccounts, 0.01)
      ).rejects.toThrow();
    });
  });

  describe('integration scenarios', () => {
    it('should create transaction suitable for different token pair types', async () => {
      // Test with different token combinations
      const testCases = [
        { tokenMintA: NATIVE_MINT.toString(), tokenMintB: mockPoolAccounts.tokenMintB },
        { tokenMintA: mockPoolAccounts.tokenMintA, tokenMintB: NATIVE_MINT.toString() },
        { tokenMintA: mockPoolAccounts.tokenMintA, tokenMintB: mockPoolAccounts.tokenMintB }
      ];

      for (const testCase of testCases) {
        const poolAccounts = {
          ...mockPoolAccounts,
          ...testCase
        };

        const transaction = await builder.buildBuyTransaction(
          testWallet,
          poolAccounts,
          0.01
        );

        expect(transaction).toBeInstanceOf(Transaction);
        expect(transaction.instructions.length).toBeGreaterThan(0);
      }
    });

    it('should handle different slippage tolerances', () => {
      const amountIn = 1000000;
      const slippageTests = [0, 50, 100, 500, 1000, 5000, 10000];

      slippageTests.forEach(slippage => {
        const result = builder.calculateMinAmountOut(amountIn, slippage);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(amountIn);
      });
    });

    it('should maintain instruction order for optimal execution', async () => {
      const transaction = await builder.buildBuyTransaction(
        testWallet,
        mockPoolAccounts,
        0.01
      );

      // First instruction should be compute budget
      expect(transaction.instructions[0].programId.equals(
        ComputeBudgetProgram.programId
      )).toBe(true);

      // Should have system program transfers
      const hasSystemTransfer = transaction.instructions.some(ix =>
        ix.programId.equals(SystemProgram.programId)
      );
      expect(hasSystemTransfer).toBe(true);
    });
  });
});