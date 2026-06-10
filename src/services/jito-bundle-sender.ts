import {
  Transaction,
  PublicKey,
  Keypair,
  Connection,
  sendAndConfirmTransaction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BotConfig } from "../types/config";
import axios, { AxiosError } from "axios";
import bs58 from "bs58";

export class JitoBundleSender {
  private config: BotConfig;
  private connection: Connection;
  private jitoTipAccount: PublicKey;
  private jitoValidators: PublicKey[];
  private jitoEndpoints: string[];

  constructor(config: BotConfig, connection: Connection) {
    this.config = config;
    this.connection = connection;
    this.jitoTipAccount = new PublicKey(config.jito.tipAccount);
    
    // Jito validator addresses
    this.jitoValidators = [
      "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
      "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
      "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
      "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
      "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
      "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
      "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
      "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    ].map(addr => new PublicKey(addr));

    // Jito endpoints
    this.jitoEndpoints = [
      `https://mainnet.block-engine.jito.wtf/api/v1/bundles?uuid=${config.jito.uuid}`,
      `https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles?uuid=${config.jito.uuid}`,
      `https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles?uuid=${config.jito.uuid}`,
      `https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles?uuid=${config.jito.uuid}`,
      `https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles?uuid=${config.jito.uuid}`,
    ];
  }

  private getRandomValidator(): PublicKey {
    return this.jitoValidators[Math.floor(Math.random() * this.jitoValidators.length)];
  }

  private async getJitoTipTransaction(payerPubkey: PublicKey, jitofee: number): Promise<VersionedTransaction> {
    const jitoValidatorWallet = this.getRandomValidator();
    const latestBlockhash = await this.connection.getLatestBlockhash();
    const fee = Math.floor(jitofee * 1000000000); // Convert SOL to lamports

    const jitoFeeMessage = new TransactionMessage({
      payerKey: payerPubkey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payerPubkey,
          toPubkey: jitoValidatorWallet,
          lamports: fee,
        }),
      ],
    }).compileToV0Message();

    return new VersionedTransaction(jitoFeeMessage);
  }

  private generateBundleId(): string {
    return `bundle-${this.config.jito.uuid}-${Date.now()}`;
  }

  public async sendBundleWithSingleTransaction(
    transaction: Transaction,
    wallet: Keypair,
    jitofee: number = 0.0001
  ): Promise<string | null> {
    try {
      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;
      transaction.sign(wallet);

      return await this.executeJitoBundle([transaction], wallet, jitofee, true);
    } catch (error) {
      console.error("Error sending Jito bundle:", error);
      return null;
    }
  }

  public async sendMultipleBundlesInParallel(
    transactions: Transaction[],
    wallets: Keypair[],
    jitofee: number = 0.0001
  ): Promise<(string | null)[]> {
    if (transactions.length !== wallets.length) {
      throw new Error("Number of transactions must match number of wallets");
    }

    console.log(`Sending ${transactions.length} bundles in parallel...`);
    
    const bundlePromises = transactions.map((transaction, index) =>
      this.sendBundleWithSingleTransaction(transaction, wallets[index], jitofee)
    );

    const results = await Promise.allSettled(bundlePromises);
    
    return results.map((result) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        console.error("Bundle promise rejected:", result.reason);
        return null;
      }
    });
  }

  public async sendTransactionsWithFallback(
    transactions: Transaction[],
    wallets: Keypair[],
    jitofee: number = 0.0001
  ): Promise<string[]> {
    const results: string[] = [];
    
    // Try to send all transactions as a single bundle first
    try {
      console.log(`Attempting to send ${transactions.length} transactions as a single Jito bundle...`);
      
      // Prepare all transactions
      const { blockhash } = await this.connection.getLatestBlockhash();
      for (let i = 0; i < transactions.length; i++) {
        transactions[i].recentBlockhash = blockhash;
        transactions[i].feePayer = wallets[i].publicKey;
        transactions[i].sign(wallets[i]);
      }

      const bundleResult = await this.executeJitoBundle(transactions, wallets[0], jitofee, true);
      
      if (bundleResult) {
        // If bundle succeeds, return the bundle ID for all transactions
        for (let i = 0; i < transactions.length; i++) {
          results.push(bundleResult);
        }
        return results;
      }
    } catch (error) {
      console.warn("Jito bundle failed, falling back to individual transactions:", error);
    }

    // Fallback to individual transactions
    for (let i = 0; i < transactions.length; i++) {
      try {
        const signature = await this.sendRegularTransaction(transactions[i], wallets[i]);
        results.push(signature);
      } catch (error) {
        console.error(`Regular transaction ${i} also failed:`, error);
        results.push(`failed-${i}-${Date.now()}`);
      }
    }
    
    return results;
  }

  private async executeJitoBundle(
    transactions: Transaction[],
    payer: Keypair,
    jitofee: number,
    addTip: boolean
  ): Promise<string | null> {
    try {
      let finalTransactions: string[] = [];
      let jitoTxSignature: string;
      const latestBlockhash = await this.connection.getLatestBlockhash();

      console.log(` Validating ${transactions.length} transactions before sending to Jito...`);

      // Validate all transactions
      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        
        if (!tx.recentBlockhash) {
          tx.recentBlockhash = latestBlockhash.blockhash;
        }
        
        if (!tx.feePayer) {
          tx.feePayer = payer.publicKey;
        }
        
        if (!tx.signatures || tx.signatures.length === 0 || !tx.signatures[0].signature) {
          tx.sign(payer);
        }
        
        // Validate signature
        const signature = tx.signatures[0];
        if (!signature || !signature.signature) {
          throw new Error(`Transaction ${i + 1} has invalid signature`);
        }

        console.log(` Transaction ${i + 1} validated`);
      }

      if (addTip) {
        const jitoFeeTransaction = await this.getJitoTipTransaction(payer.publicKey, jitofee);
        jitoFeeTransaction.sign([payer]);
        
        const tipSignature = jitoFeeTransaction.signatures[0];
        if (tipSignature && tipSignature instanceof Uint8Array && tipSignature.length > 0) {
          const isAllZeros = tipSignature.every(byte => byte === 0);
          if (!isAllZeros) {
            jitoTxSignature = bs58.encode(tipSignature);
            console.log(` Jito tip transaction signature: ${jitoTxSignature.substring(0, 20)}...`);
          } else {
            jitoTxSignature = this.generateBundleId();
          }
        } else {
          jitoTxSignature = this.generateBundleId();
        }
        
        const serializedJitoFeeTransaction = bs58.encode(jitoFeeTransaction.serialize());
        finalTransactions.push(serializedJitoFeeTransaction);
        console.log('Added Jito tip transaction');
      } else {
        // Get signature from first transaction for tracking
        const firstTx = transactions[0];
        const firstTxSignature = firstTx.signatures[0];
        
        if (firstTxSignature && firstTxSignature.signature instanceof Uint8Array) {
          jitoTxSignature = bs58.encode(firstTxSignature.signature);
          console.log(` Bundle signature: ${jitoTxSignature.substring(0, 20)}...`);
        } else {
          jitoTxSignature = this.generateBundleId();
        }
      }

      // Serialize all transactions
      for (let i = 0; i < transactions.length; i++) {
        try {
          const serializedTransaction = bs58.encode(transactions[i].serialize());
          finalTransactions.push(serializedTransaction);
          console.log(` Serialized transaction ${i + 1}`);
        } catch (error) {
          console.error(` Error serializing transaction ${i + 1}:`, error);
          throw new Error(`Failed to serialize transaction ${i + 1}: ${error}`);
        }
      }

      console.log(`📤 Sending bundle with ${finalTransactions.length} transactions to Jito...`);

      const requests = this.jitoEndpoints.map((url) =>
        axios.post(url, {
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [finalTransactions],
        })
      );

      const responses = await Promise.all(requests.map((p) => p.catch((e: Error) => e)));
      
      const errors = responses.filter((r): r is Error => r instanceof Error);
      const successes = responses.filter((r: any): r is any => !(r instanceof Error));
      
      if (errors.length > 0) {
        console.error(` Jito API errors (${errors.length}/${this.jitoEndpoints.length} endpoints failed)`);
        errors.forEach((error: Error, index: number) => {
          console.error(`Error ${index + 1}:`, error.message);
        });
      }
      
      if (successes.length > 0) {
        console.log(` Bundle accepted by ${successes.length}/${this.jitoEndpoints.length} Jito endpoints`);
        return jitoTxSignature;
      } else {
        console.error(" Bundle rejected by all Jito endpoints");
        return null;
      }
    } catch (error: unknown) {
      console.error("Error executing Jito bundle:", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private async sendRegularTransaction(
    transaction: Transaction,
    wallet: Keypair
  ): Promise<string> {
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;

    return await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [wallet],
      {
        skipPreflight: true,
        commitment: "processed",
      }
    );
  }

  public async waitForBundleConfirmation(
    signature: string,
    maxWaitTime: number = 30000
  ): Promise<boolean> {
    if (!signature || signature.includes("bundle-") || signature.includes("placeholder")) {
      console.warn("⚠️ Cannot confirm transaction with placeholder signature");
      return false;
    }

    console.log(`Confirming transaction: ${signature}`);
    
    try {
      const latestBlockhash = await this.connection.getLatestBlockhash();
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Transaction confirmation timeout"));
        }, maxWaitTime);
      });
      
      const confirmationPromise = this.connection.confirmTransaction(
        {
          signature,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          blockhash: latestBlockhash.blockhash,
        },
        "confirmed"
      );
      
      const confirmation = await Promise.race([confirmationPromise, timeoutPromise]);
      const isConfirmed = !confirmation.value.err;
      
      if (isConfirmed) {
        console.log(" Transaction confirmed successfully");
      } else {
        console.warn("⚠️ Transaction failed:", confirmation.value.err);
      }
      
      return isConfirmed;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("timeout")) {
        console.error("⏰ Transaction confirmation timed out");
      } else {
        console.error(" Error confirming transaction:", error instanceof Error ? error.message : String(error));
      }
      return false;
    }
  }
}