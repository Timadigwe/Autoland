import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { SolanaParser } from "../utils/simple-parser";
import { Idl } from "@coral-xyz/anchor";
import { BotConfig } from "../types/config";
import * as bs58 from "bs58";

export class MeteoraTransactionParser {
  private parser: SolanaParser;
  private meteoraProgramId: PublicKey;
  private config: BotConfig;

  constructor(meteoraProgramId: string, meteoraIdl: Idl, config: BotConfig) {
    this.meteoraProgramId = new PublicKey(meteoraProgramId);
    this.config = config;
    this.parser = new SolanaParser([]);
    this.parser.addParserFromIdl(meteoraProgramId, meteoraIdl);
  }

  private formatTransaction(transactionData: any): VersionedTransactionResponse | null {
    try {
      if (transactionData?.transaction?.transaction) {
        let meta = transactionData.transaction.meta;
        return {
          transaction: transactionData.transaction.transaction,
          meta: meta,
          version: "legacy",
        } as VersionedTransactionResponse;
      }
      if (transactionData?.transaction?.message && transactionData?.meta) {
        return transactionData as VersionedTransactionResponse;
      }
      return null;
    } catch (error) {
      return null;
    }
  }



  public getTransactionSignature(transactionData: any): string | null {
    try {
      // Check for GRPC stream format: transactionData.transaction.transaction.signature (Buffer)
      if (transactionData?.transaction?.transaction?.signature) {
        const sigBuffer = transactionData.transaction.transaction.signature;
        if (Buffer.isBuffer(sigBuffer) || sigBuffer instanceof Uint8Array) {
          // Convert to base58 (Solana standard)
          return bs58.encode(sigBuffer);
        }
      }
      
      // Fallback to other possible formats
      return transactionData?.transaction?.signatures?.[0] || null;
    } catch (error) {
      console.log(" Error extracting transaction signature:", error);
      return null;
    }
  }

  public isSwapTransaction(transactionData: any): boolean {
    try {
      const formattedTxn = this.formatTransaction(transactionData);
      if (!formattedTxn || !formattedTxn.meta || formattedTxn.meta.err) {
        return false;
      }

      // Check if this is a Meteora swap transaction
      if (formattedTxn.meta?.logMessages) {
        const meteoraSwapLogs = formattedTxn.meta.logMessages.filter((log: string) => 
          log.includes(this.meteoraProgramId.toString()) &&
          (log.includes("Instruction: Swap") || log.includes("swap"))
        );

        if (meteoraSwapLogs.length > 0) {
          console.log(` Meteora swap transaction detected!`);
          return true;
        }
      }

      return false;
    } catch (error) {
      console.error(" Error in isSwapTransaction:", error);
      return false;
    }
  }

  private readonly JITO_TIP_ACCOUNTS = [
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  ];

  public extractCompetitorTip(transactionData: any): number | null {
    try {
      const formattedTxn = this.formatTransaction(transactionData);
      if (!formattedTxn || !formattedTxn.meta || formattedTxn.meta.err) return null;

      // 1. Verify this transaction actually interacts with Meteora DLMM
      const accountKeys = transactionData?.transaction?.transaction?.message?.accountKeys;
      if (!accountKeys) return null;
      
      const keys = accountKeys.map((keyBuf: any) => {
        if (Buffer.isBuffer(keyBuf) || keyBuf instanceof Uint8Array) {
           return bs58.encode(keyBuf);
        }
        return typeof keyBuf === 'string' ? keyBuf : '';
      });

      if (!keys.includes(this.meteoraProgramId.toString())) {
        return null; // Not a competitor
      }

      // 2. Find if any Jito tip account balance increased
      const preBalances = formattedTxn.meta.preBalances;
      const postBalances = formattedTxn.meta.postBalances;
      
      if (!preBalances || !postBalances) return null;

      for (let i = 0; i < keys.length; i++) {
        if (this.JITO_TIP_ACCOUNTS.includes(keys[i])) {
           const tipPaid = postBalances[i] - preBalances[i];
           if (tipPaid > 0) {
             return tipPaid; // Found the MEV tip!
           }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

}