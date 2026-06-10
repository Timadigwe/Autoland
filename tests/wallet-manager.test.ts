import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { WalletManager } from '../src/services/wallet-manager';

// Mock the Connection class
jest.mock('@solana/web3.js', () => ({
  ...jest.requireActual('@solana/web3.js'),
  Connection: jest.fn()
}));

// Mock bs58
jest.mock('bs58');

describe('WalletManager', () => {
  let walletManager: WalletManager;
  let mockConnection: jest.Mocked<Connection>;
  let testKeypairs: Keypair[];
  let testPrivateKeys: string[];

  beforeEach(() => {
    // Create test keypairs
    testKeypairs = [
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate()
    ];

    // Create mock private keys
    testPrivateKeys = [
      'test-private-key-1',
      'test-private-key-2',
      'test-private-key-3'
    ];

    // Mock Connection
    mockConnection = {
      getBalance: jest.fn(),
    } as any;

    (Connection as jest.Mock).mockImplementation(() => mockConnection);

    // Mock bs58.decode to return test keypairs
    (bs58.decode as jest.Mock).mockImplementation((privateKey: string) => {
      const index = testPrivateKeys.indexOf(privateKey);
      if (index >= 0) {
        return testKeypairs[index].secretKey;
      }
      throw new Error('Invalid private key');
    });

    // Mock Keypair.fromSecretKey
    jest.spyOn(Keypair, 'fromSecretKey').mockImplementation((secretKey: Uint8Array) => {
      const index = testKeypairs.findIndex(kp => 
        kp.secretKey.every((byte, i) => byte === secretKey[i])
      );
      return testKeypairs[index] || testKeypairs[0];
    });

    walletManager = new WalletManager(mockConnection);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with connection', () => {
      expect(walletManager).toBeInstanceOf(WalletManager);
    });
  });

  describe('initializeWallets', () => {
    it('should initialize wallets with balances', async () => {
      // Mock balance responses
      mockConnection.getBalance
        .mockResolvedValueOnce(1 * LAMPORTS_PER_SOL)    // 1 SOL
        .mockResolvedValueOnce(2.5 * LAMPORTS_PER_SOL)  // 2.5 SOL
        .mockResolvedValueOnce(0.1 * LAMPORTS_PER_SOL); // 0.1 SOL

      await walletManager.initializeWallets(testPrivateKeys);

      const wallets = walletManager.getWallets();

      expect(wallets).toHaveLength(3);
      expect(wallets[0].solBalance).toBe(1);
      expect(wallets[1].solBalance).toBe(2.5);
      expect(wallets[2].solBalance).toBe(0.1);
      
      expect(mockConnection.getBalance).toHaveBeenCalledTimes(3);
    });

    it('should handle empty private keys array', async () => {
      await walletManager.initializeWallets([]);

      const wallets = walletManager.getWallets();
      expect(wallets).toHaveLength(0);
    });

    it('should throw error for invalid private key', async () => {
      (bs58.decode as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid private key format');
      });

      await expect(
        walletManager.initializeWallets(['invalid-key'])
      ).rejects.toThrow();
    });

    it('should handle connection errors during balance fetching', async () => {
      mockConnection.getBalance.mockRejectedValue(new Error('Network error'));

      await expect(
        walletManager.initializeWallets(testPrivateKeys.slice(0, 1))
      ).rejects.toThrow();
    });

    it('should set correct wallet properties', async () => {
      mockConnection.getBalance.mockResolvedValue(1.5 * LAMPORTS_PER_SOL);

      await walletManager.initializeWallets([testPrivateKeys[0]]);

      const wallet = walletManager.getWallet(0);
      
      expect(wallet).toBeDefined();
      expect(wallet!.keypair).toBe(testKeypairs[0]);
      expect(wallet!.publicKey).toBe(testKeypairs[0].publicKey.toString());
      expect(wallet!.solBalance).toBe(1.5);
    });
  });

  describe('getWallet', () => {
    beforeEach(async () => {
      mockConnection.getBalance.mockResolvedValue(1 * LAMPORTS_PER_SOL);
      await walletManager.initializeWallets(testPrivateKeys);
    });

    it('should return wallet by index', () => {
      const wallet = walletManager.getWallet(0);
      
      expect(wallet).toBeDefined();
      expect(wallet!.publicKey).toBe(testKeypairs[0].publicKey.toString());
    });

    it('should return undefined for invalid index', () => {
      expect(walletManager.getWallet(10)).toBeUndefined();
      expect(walletManager.getWallet(-1)).toBeUndefined();
    });
  });

  describe('refreshBalances', () => {
    beforeEach(async () => {
      mockConnection.getBalance.mockResolvedValue(1 * LAMPORTS_PER_SOL);
      await walletManager.initializeWallets(testPrivateKeys);
    });

    it('should refresh all wallet balances', async () => {
      // Clear previous calls
      jest.clearAllMocks();
      
      // Mock new balance responses
      mockConnection.getBalance
        .mockResolvedValueOnce(2 * LAMPORTS_PER_SOL)
        .mockResolvedValueOnce(3 * LAMPORTS_PER_SOL)
        .mockResolvedValueOnce(1.5 * LAMPORTS_PER_SOL);

      await walletManager.refreshBalances();

      const wallets = walletManager.getWallets();
      expect(wallets[0].solBalance).toBe(2);
      expect(wallets[1].solBalance).toBe(3);
      expect(wallets[2].solBalance).toBe(1.5);
      
      expect(mockConnection.getBalance).toHaveBeenCalledTimes(3);
    });

    it('should handle errors during balance refresh', async () => {
      mockConnection.getBalance.mockRejectedValue(new Error('Network error'));

      await expect(walletManager.refreshBalances()).rejects.toThrow();
    });
  });

  describe('getWalletsWithSufficientBalance', () => {
    beforeEach(async () => {
      mockConnection.getBalance
        .mockResolvedValueOnce(2 * LAMPORTS_PER_SOL)    // 2 SOL
        .mockResolvedValueOnce(0.5 * LAMPORTS_PER_SOL)  // 0.5 SOL
        .mockResolvedValueOnce(1.5 * LAMPORTS_PER_SOL); // 1.5 SOL

      await walletManager.initializeWallets(testPrivateKeys);
    });

    it('should return wallets with sufficient balance', () => {
      const wallets = walletManager.getWalletsWithSufficientBalance(1);
      
      expect(wallets).toHaveLength(2); // Wallets with 2 SOL and 1.5 SOL
      expect(wallets[0].solBalance).toBe(2);
      expect(wallets[1].solBalance).toBe(1.5);
    });

    it('should return empty array if no wallets have sufficient balance', () => {
      const wallets = walletManager.getWalletsWithSufficientBalance(10);
      
      expect(wallets).toHaveLength(0);
    });

    it('should handle exact balance match', () => {
      const wallets = walletManager.getWalletsWithSufficientBalance(1.5);
      
      expect(wallets).toHaveLength(2); // 2 SOL and 1.5 SOL (exact match)
    });

    it('should handle zero minimum balance', () => {
      const wallets = walletManager.getWalletsWithSufficientBalance(0);
      
      expect(wallets).toHaveLength(3); // All wallets
    });
  });

  describe('getTotalBalance', () => {
    beforeEach(async () => {
      mockConnection.getBalance
        .mockResolvedValueOnce(1 * LAMPORTS_PER_SOL)
        .mockResolvedValueOnce(2.5 * LAMPORTS_PER_SOL)
        .mockResolvedValueOnce(0.75 * LAMPORTS_PER_SOL);

      await walletManager.initializeWallets(testPrivateKeys);
    });

    it('should return sum of all wallet balances', () => {
      const totalBalance = walletManager.getTotalBalance();
      
      expect(totalBalance).toBe(4.25); // 1 + 2.5 + 0.75
    });

    it('should return 0 for empty wallet list', () => {
      const emptyWalletManager = new WalletManager(mockConnection);
      
      expect(emptyWalletManager.getTotalBalance()).toBe(0);
    });
  });

  describe('getWalletCount', () => {
    it('should return correct wallet count', async () => {
      mockConnection.getBalance.mockResolvedValue(1 * LAMPORTS_PER_SOL);
      
      expect(walletManager.getWalletCount()).toBe(0);
      
      await walletManager.initializeWallets(testPrivateKeys.slice(0, 2));
      
      expect(walletManager.getWalletCount()).toBe(2);
    });
  });

  describe('error scenarios', () => {
    it('should handle malformed private keys gracefully', async () => {
      (bs58.decode as jest.Mock).mockImplementation((key: string) => {
        if (key === 'malformed-key') {
          throw new Error('Invalid base58 character');
        }
        return testKeypairs[0].secretKey;
      });

      await expect(
        walletManager.initializeWallets(['valid-key', 'malformed-key'])
      ).rejects.toThrow();
    });

    it('should handle network timeouts during balance checks', async () => {
      mockConnection.getBalance.mockImplementation(() => 
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 100)
        )
      );

      await expect(
        walletManager.initializeWallets([testPrivateKeys[0]])
      ).rejects.toThrow('Timeout');
    });

    it('should handle partial failures during parallel balance fetching', async () => {
      mockConnection.getBalance
        .mockResolvedValueOnce(1 * LAMPORTS_PER_SOL)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(2 * LAMPORTS_PER_SOL);

      await expect(
        walletManager.initializeWallets(testPrivateKeys)
      ).rejects.toThrow();
    });
  });

  describe('integration scenarios', () => {
    it('should maintain wallet state consistency across operations', async () => {
      // Initialize with specific balances
      mockConnection.getBalance
        .mockResolvedValueOnce(1 * LAMPORTS_PER_SOL)
        .mockResolvedValueOnce(2 * LAMPORTS_PER_SOL);

      await walletManager.initializeWallets(testPrivateKeys.slice(0, 2));

      // Check initial state
      expect(walletManager.getWalletCount()).toBe(2);
      expect(walletManager.getTotalBalance()).toBe(3);

      // Update balances
      mockConnection.getBalance
        .mockResolvedValueOnce(1.5 * LAMPORTS_PER_SOL)
        .mockResolvedValueOnce(2.5 * LAMPORTS_PER_SOL);

      await walletManager.refreshBalances();

      // Verify updated state
      expect(walletManager.getTotalBalance()).toBe(4);
      expect(walletManager.getWalletsWithSufficientBalance(2).length).toBe(1);
    });

    it('should handle large number of wallets efficiently', async () => {
      const manyPrivateKeys = Array(100).fill(0).map((_, i) => `private-key-${i}`);
      const manyKeypairs = Array(100).fill(0).map(() => Keypair.generate());

      (bs58.decode as jest.Mock).mockImplementation((privateKey: string) => {
        const index = manyPrivateKeys.indexOf(privateKey);
        return manyKeypairs[index].secretKey;
      });

      jest.spyOn(Keypair, 'fromSecretKey').mockImplementation((secretKey: Uint8Array) => {
        const index = manyKeypairs.findIndex(kp => 
          kp.secretKey.every((byte, i) => byte === secretKey[i])
        );
        return manyKeypairs[index];
      });

      // Mock balance for all wallets
      mockConnection.getBalance.mockResolvedValue(1 * LAMPORTS_PER_SOL);

      await walletManager.initializeWallets(manyPrivateKeys);

      expect(walletManager.getWalletCount()).toBe(100);
      expect(walletManager.getTotalBalance()).toBe(100);
      expect(mockConnection.getBalance).toHaveBeenCalledTimes(100);
    });
  });
});