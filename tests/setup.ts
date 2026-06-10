import { jest } from '@jest/globals';

// Mock environment variables for testing
process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
process.env.GRPC_URL = 'grpc://localhost:8000';
process.env.METEORA_CONFIG_ACCOUNT = 'ELZt9LY2LnPCBYH7YfhW3f5qGYL3nG3eJbdNGVe1B3cV';
process.env.METEORA_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
process.env.JITO_BLOCK_ENGINE_URL = 'https://mainnet.block-engine.jito.wtf';
process.env.JITO_TIP_ACCOUNT = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
process.env.TRADE_AMOUNT_SOL = '0.01';
process.env.MAX_SLIPPAGE_BPS = '500';
process.env.PRIORITY_FEE_MICRO_LAMPORTS = '10000';

// Global test timeout
jest.setTimeout(30000);