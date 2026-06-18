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
      `https://mainnet.block-engine.jito.wtf/api/v1/bundles`,
      `https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles`,
      `https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles`,
      `https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles`,
      `https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles`,
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
    return `bundle-${Date.now()}`;
  }

  public async sendBundleWithSingleTransaction(
    transaction: Transaction,
    wallet: Keypair,
    jitofee: number = 0.0001
  ): Promise<string | null> {
    try {
      if (!transaction.recentBlockhash || !transaction.feePayer || (!transaction.signatures || transaction.signatures.length === 0)) {
        throw new Error("Transaction must be pre-constructed and signed.");
      }

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

      const bundleResult = await this.executeJitoBundle(transactions, wallets[0], jitofee, true);

      if (bundleResult) {
        // If bundle succeeds, return the bundle ID for all transactions
        for (let i = 0; i < transactions.length; i++) {
          results.push(bundleResult);
        }
        return results;
      }
    } catch (error: any) {
      console.warn("Jito bundle failed, falling back to individual transactions:", error);
      
      // If Jito explicitly rejected the bundle due to simulation failure, the transactions are invalid.
      // Standard RPC fallback will also fail, so we throw the error upwards to the AI Agent immediately.
      if (error.message && error.message.includes("Jito API Simulation Error")) {
        throw error;
      }
      
      // If this is a multi-transaction bundle (Swapless Rebalance), standard RPC will process them out-of-order and fail.
      // We must throw instead of falling back.
      if (transactions.length > 1) {
         throw new Error("Multiple transactions cannot be reliably sent via standard RPC fallback. Aborting to avoid partial execution.");
      }
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

        if (!tx.recentBlockhash || !tx.feePayer) {
          throw new Error(`Transaction ${i + 1} must be fully constructed and signed before sending to Jito`);
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

      console.log(`Sending bundle with ${finalTransactions.length} transactions to Jito...`);

      let jitoResponse = null;
      let jitoError = null;

      // Try primary endpoint (Frankfurt) first to avoid 429 rate limits from broadcasting.
      // Fallback sequentially to Amsterdam and Mainnet if needed.
      const primaryEndpoint = this.jitoEndpoints[2]; // Frankfurt
      const fallbackEndpoints = [this.jitoEndpoints[1], this.jitoEndpoints[0]];
      
      const endpointsToTry = [primaryEndpoint, ...fallbackEndpoints];
      
      for (const url of endpointsToTry) {
        try {
          const response = await axios.post(url, {
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [finalTransactions],
          });
          
          // Jito returns HTTP 200 even if the bundle fails internal simulation.
          // We MUST explicitly check for the embedded error object to detect simulation failures.
          if (response.data && response.data.error) {
            throw new Error(`Jito API Simulation Error: ${JSON.stringify(response.data.error)}`);
          }
          
          jitoResponse = response;
          console.log(` Bundle accepted by Jito endpoint: ${url}`);
          break; // Success, stop trying other endpoints
        } catch (error: any) {
          let errorMsg = error.message;
          if (error.response && error.response.data) {
             errorMsg += ` - Data: ${JSON.stringify(error.response.data)}`;
          }
          
          // If it's a simulation error, DO NOT fallback. The transaction is fundamentally invalid.
          if (errorMsg.includes("Jito API Simulation Error")) {
             console.error(` Jito Block Engine rejected bundle (Simulation Failed): ${errorMsg}`);
             throw error; 
          }
          
          console.warn(` Failed to send to ${url}: ${errorMsg}`);
          jitoError = error;
        }
      }

      if (!jitoResponse) {
         console.error(" Bundle rejected by all attempted Jito endpoints.");
         throw jitoError || new Error("All Jito endpoints failed");
      }

      return jitoTxSignature;
    } catch (error: any) {
      console.error("Error executing Jito bundle:", error.message || String(error));
      throw error; // Throw to trigger proper telemetry handling
    }
  }

  private async sendRegularTransaction(
    transaction: Transaction,
    wallet: Keypair
  ): Promise<string> {
    if (!transaction.recentBlockhash || !transaction.feePayer || (!transaction.signatures || transaction.signatures.length === 0)) {
       throw new Error("Transaction must be pre-constructed and signed.");
    }
    
    // We do NOT want to use sendAndConfirmTransaction because it is a blocking RPC polling call.
    // Our entire architecture relies on the gRPC stream. We just blast it to the network.
    const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 0
    });
    
    return signature;
  }

  public async waitForBundleConfirmation(
    signature: string,
    maxWaitTime: number = 30000
  ): Promise<boolean> {
    if (!signature || signature.includes("bundle-") || signature.includes("placeholder")) {
      console.warn("Cannot confirm transaction with placeholder signature");
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