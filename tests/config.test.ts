import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager } from '../src/utils/config';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('ConfigManager', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Clear all environment variables
    Object.keys(process.env).forEach(key => {
      if (key.startsWith('GRPC_') ||
        key.startsWith('METEORA_') ||
        key.startsWith('JITO_') ||
        key.startsWith('PRIVATE_') ||
        key.startsWith('TRADE_') ||
        key.startsWith('MAX_') ||
        key.startsWith('PRIORITY_')) {
        delete process.env[key];
      }
    });

    // Reset singleton
    (ConfigManager as any).instance = null;

    // Clear mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      // Setup required env vars
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_CONFIG_ACCOUNT = 'test-account';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS = 'key1,key2';

      const instance1 = ConfigManager.getInstance();
      const instance2 = ConfigManager.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('loadConfig with environment variables', () => {
    it('should load configuration from environment variables', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.X_TOKEN = 'test-token';
      process.env.METEORA_CONFIG_ACCOUNT = 'test-account';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.TRADE_AMOUNT_SOL = '0.05';
      process.env.MAX_SLIPPAGE_BPS = '300';
      process.env.PRIORITY_FEE_MICRO_LAMPORTS = '15000';
      process.env.PRIVATE_KEYS = 'key1,key2,key3';

      const config = ConfigManager.getInstance().getConfig();

      expect(config).toEqual({
        rpc: {
          url: 'https://api.mainnet-beta.solana.com'
        },
        grpc: {
          url: 'grpc://localhost:8000',
          token: 'test-token'
        },
        meteora: {
          programId: 'test-program-id'
        },
        jito: {
          blockEngineUrl: 'https://test.jito.wtf',
          tipAccount: 'test-tip-account',
          uuid: 'test-uuid',
          singleTransactionPerBundle: false
        },
        trading: {
          tradeAmountSol: 0.05,
          maxSlippageBps: 300,
          priorityFeeMicroLamports: 15000,
          usePercentageOfBalance: false,
          balancePercentage: 90
        },
        wallets: {
          privateKeys: ['key1', 'key2', 'key3']
        },
        dlmm: {
          targetPool: 'test-pool'
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
      });
    });

    it('should use default values for optional trading parameters', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS = 'key1';

      const config = ConfigManager.getInstance().getConfig();

      expect(config.trading).toEqual({
        tradeAmountSol: 0.01,
        maxSlippageBps: 500,
        priorityFeeMicroLamports: 10000,
        usePercentageOfBalance: false,
        balancePercentage: 90
      });
    });

    it('should throw error for missing required environment variables', () => {
      // Missing GRPC_URL
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS = 'key1';

      expect(() => {
        ConfigManager.getInstance();
      }).toThrow('Missing required environment variable: GRPC_URL');
    });
  });

  describe('loadPrivateKeys from file', () => {
    it('should load private keys from file', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS_FILE = './config/private-keys.txt';

      const mockFileContent = `# Comment line
key1
key2

key3
# Another comment
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(mockFileContent);

      const config = ConfigManager.getInstance().getConfig();

      expect(config.wallets.privateKeys).toEqual(['key1', 'key2', 'key3']);
      expect(mockFs.existsSync).toHaveBeenCalledWith(path.resolve('./config/private-keys.txt'));
    });

    it('should throw error if private keys file does not exist', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS_FILE = './config/nonexistent.txt';

      mockFs.existsSync.mockReturnValue(false);

      expect(() => {
        ConfigManager.getInstance();
      }).toThrow('Private keys file not found: ' + path.resolve('./config/nonexistent.txt'));
    });

    it('should throw error if private keys file is empty', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS_FILE = './config/empty.txt';

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('# Only comments\n\n# No keys');

      expect(() => {
        ConfigManager.getInstance();
      }).toThrow('No private keys found in file');
    });

    it('should handle file read errors', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS_FILE = './config/private-keys.txt';

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      expect(() => {
        ConfigManager.getInstance();
      }).toThrow('Error reading private keys file');
    });

    it('should filter out empty lines and comments correctly', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS_FILE = './config/private-keys.txt';

      const complexFileContent = `
# Header comment
   
key1-with-spaces   
# Inline comment
key2


key3-after-empty-lines
#key4-commented-out
key5
   # comment with spaces
`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(complexFileContent);

      const config = ConfigManager.getInstance().getConfig();

      expect(config.wallets.privateKeys).toEqual([
        'key1-with-spaces',
        'key2',
        'key3-after-empty-lines',
        'key5'
      ]);
    });
  });

  describe('error handling', () => {
    it('should throw error when both file and env var are missing', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';

      expect(() => {
        ConfigManager.getInstance();
      }).toThrow('Either PRIVATE_KEYS_FILE or PRIVATE_KEYS environment variable must be set');
    });

    it('should prioritize file over environment variable', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS_FILE = './config/private-keys.txt';
      process.env.PRIVATE_KEYS = 'env-key1,env-key2';

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('file-key1\nfile-key2');

      const config = ConfigManager.getInstance().getConfig();

      expect(config.wallets.privateKeys).toEqual(['file-key1', 'file-key2']);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration partially', () => {
      process.env.RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.GRPC_URL = 'grpc://localhost:8000';
      process.env.METEORA_PROGRAM_ID = 'test-program-id';
      process.env.JITO_BLOCK_ENGINE_URL = 'https://test.jito.wtf';
      process.env.JITO_TIP_ACCOUNT = 'test-tip-account';
      process.env.JITO_UUID = 'test-uuid';
      process.env.DLMM_TARGET_POOL = 'test-pool';
      process.env.OPENROUTER_API_KEY = 'test-api-key';
      process.env.PRIVATE_KEYS = 'key1,key2';

      const configManager = ConfigManager.getInstance();

      configManager.updateConfig({
        trading: {
          tradeAmountSol: 0.1,
          maxSlippageBps: 1000,
          priorityFeeMicroLamports: 20000,
          usePercentageOfBalance: false,
          balancePercentage: 90
        }
      });

      const updatedConfig = configManager.getConfig();

      expect(updatedConfig.trading.tradeAmountSol).toBe(0.1);
      expect(updatedConfig.trading.maxSlippageBps).toBe(1000);
      expect(updatedConfig.trading.priorityFeeMicroLamports).toBe(20000);

      // Other config should remain unchanged
      expect(updatedConfig.grpc.url).toBe('grpc://localhost:8000');
    });
  });
});