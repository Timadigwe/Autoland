import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { WalletInfo } from "../types/config";

export class WalletManager {
  private connection: Connection;
  private wallets: WalletInfo[] = [];

  constructor(connection: Connection) {
    this.connection = connection;
  }

  public async initializeWallets(privateKeys: string[]): Promise<void> {
    console.log(`Initializing ${privateKeys.length} wallets...`);
    
    const walletPromises = privateKeys.map(async (privateKey, index) => {
      try {
        const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
        const publicKey = keypair.publicKey.toString();
        
        const balance = await this.connection.getBalance(keypair.publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;
        
        console.log(`Wallet ${index + 1}: ${publicKey} - Balance: ${solBalance.toFixed(4)} SOL`);
        
        return {
          keypair,
          publicKey,
          solBalance,
        };
      } catch (error) {
        console.error(`Error initializing wallet ${index + 1}:`, error);
        throw error;
      }
    });

    this.wallets = await Promise.all(walletPromises);
    console.log(`Successfully initialized ${this.wallets.length} wallets`);
  }

  public getWallets(): WalletInfo[] {
    return this.wallets;
  }

  public getWallet(index: number): WalletInfo | undefined {
    return this.wallets[index];
  }

  public async refreshBalances(): Promise<void> {
    console.log("Refreshing wallet balances...");
    
    const balancePromises = this.wallets.map(async (wallet) => {
      const balance = await this.connection.getBalance(wallet.keypair.publicKey);
      wallet.solBalance = balance / LAMPORTS_PER_SOL;
      return wallet;
    });

    await Promise.all(balancePromises);
    console.log("Wallet balances refreshed");
  }

  public getWalletsWithSufficientBalance(minSol: number): WalletInfo[] {
    return this.wallets.filter(wallet => wallet.solBalance >= minSol);
  }

  public getTotalBalance(): number {
    return this.wallets.reduce((total, wallet) => total + wallet.solBalance, 0);
  }

  public getWalletCount(): number {
    return this.wallets.length;
  }
}