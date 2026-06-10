import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { SolanaParser } from "../utils/simple-parser";
import { Idl } from "@coral-xyz/anchor";
import { PoolAccounts, BotConfig } from "../types/config";
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

  public parsePoolCreationTransaction(
    transactionData: any
  ): PoolAccounts | null {
    try {
      const formattedTxn = this.formatTransaction(transactionData);
      if (!formattedTxn || !formattedTxn.meta || formattedTxn.meta.err) {
        return null;
      }

      console.log(" Attempting to parse pool creation transaction...");

      // First, try the IDL-based parsing
      // console.log(" Formatted transaction:", formattedTxn.transaction.message);
      console.log(" Meta:", formattedTxn.meta.loadedAddresses);
      const parsedIxs = this.parser.parseTransactionData(
        formattedTxn.transaction.message,
        formattedTxn.meta.loadedAddresses
      );

      const meteoraIxs = parsedIxs.filter((ix) =>
        ix.programId.equals(this.meteoraProgramId)
      );

      if (meteoraIxs.length > 0) {
        const poolCreationIx = meteoraIxs.find((ix) => 
          ix.name === "initializePool" || 
          ix.name === "initializePermissionedPool" ||
          ix.name === "initializePermissionlessPool"
        );

        if (poolCreationIx) {
          console.log(" Pool creation instruction found via IDL parsing");
          return this.extractPoolAccounts(poolCreationIx);
        }
      }

      // Fallback: Extract accounts from raw transaction data
      console.log("⚠️ IDL parsing failed, attempting manual account extraction...");
      return this.extractAccountsFromRawTransaction(formattedTxn);

    } catch (error) {
      console.error("Error parsing Meteora transaction:", error);
      return null;
    }
  }

  private extractAccountsFromRawTransaction(transaction: VersionedTransactionResponse): PoolAccounts | null {
    try {
      console.log("🔧 Extracting real pool accounts from transaction...");
      
      const message = transaction.transaction.message as any;
      const staticAccountKeys = message.staticAccountKeys || [];
      const compiledInstructions = message.compiledInstructions || [];

      console.log(` Found ${staticAccountKeys.length} static account keys`);
      console.log(` Found ${compiledInstructions.length} compiled instructions`);

      // Find the Meteora instruction (program index 18 from the logs)
      const meteoraInstruction = compiledInstructions.find((ix: any) => {
        const programAccount = staticAccountKeys[ix.programIdIndex];
        return programAccount && programAccount.toString() === this.meteoraProgramId.toString();
      });

      if (!meteoraInstruction) {
        console.log(" No Meteora instruction found");
        return null;
      }

      console.log(" Found Meteora instruction");
      console.log(" Account indexes:", meteoraInstruction.accountKeyIndexes);

      const accountIndexes = meteoraInstruction.accountKeyIndexes;
      if (!accountIndexes || accountIndexes.length < 13) {
        console.log(" Insufficient accounts in Meteora instruction");
        return null;
      }

      // Extract accounts based on correct Meteora pool creation instruction layout
      // Account indexes: [1, 19, 2, 20, 21, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 22, 16, 23, 24, 25, 26, 27]
      // Based on Solscan account mapping for InitializePermissionlessConstantProductPoolWithConfig
      const poolAccounts: PoolAccounts = {
        pool: staticAccountKeys[accountIndexes[0]]?.toString() || "Unknown",           // #1 Pool (index 1)
        lpMint: staticAccountKeys[accountIndexes[2]]?.toString() || "Unknown",         // #3 Lp Mint (index 2)
        tokenMintA: staticAccountKeys[accountIndexes[3]]?.toString() || "Unknown",     // #4 Token A Mint (index 20) 
        tokenMintB: staticAccountKeys[accountIndexes[4]]?.toString() || "Unknown",     // #5 Token B Mint (index 21)
        aVault: staticAccountKeys[accountIndexes[5]]?.toString() || "Unknown",         // #6 A Vault (index 3)
        bVault: staticAccountKeys[accountIndexes[6]]?.toString() || "Unknown",         // #7 B Vault (index 4)
        aTokenVault: staticAccountKeys[accountIndexes[7]]?.toString() || "Unknown",    // #8 A Token Vault (index 5)
        bTokenVault: staticAccountKeys[accountIndexes[8]]?.toString() || "Unknown",    // #9 B Token Vault (index 6)
        aVaultLpMint: staticAccountKeys[accountIndexes[9]]?.toString() || "Unknown",   // #10 A Vault Lp Mint (index 7)
        bVaultLpMint: staticAccountKeys[accountIndexes[10]]?.toString() || "Unknown",  // #11 B Vault Lp Mint (index 8)
        aVaultLp: staticAccountKeys[accountIndexes[11]]?.toString() || "Unknown",      // #12 A Vault Lp (index 9)
        bVaultLp: staticAccountKeys[accountIndexes[12]]?.toString() || "Unknown",      // #13 B Vault Lp (index 10)
        protocolTokenFee: staticAccountKeys[accountIndexes[16]]?.toString() || "Unknown", // #17 Protocol Token Fee (5vTiUqpobSZ18aRfCXXBZEHxc47HA1Gbw1dLSK2CpGzv)
      };

      console.log(" Real pool accounts extracted:");
      console.log(`  Pool: ${poolAccounts.pool}`);
      console.log(`  LP Mint: ${poolAccounts.lpMint}`);
      console.log(`  Token A: ${poolAccounts.tokenMintA}`);
      console.log(`  Token B: ${poolAccounts.tokenMintB}`);
      console.log(`  Protocol Token Fee: ${poolAccounts.protocolTokenFee}`);

      return poolAccounts;
    } catch (error) {
      console.error("Error extracting accounts from raw transaction:", error);
      return null;
    }
  }



  private formatTransaction(data: any): VersionedTransactionResponse | null {
    try {
      // Handle GRPC stream format: data.transaction.transaction contains the actual transaction
      let actualTransaction, slot, meta;
      
      if (data.transaction?.transaction) {
        // GRPC format: data.transaction.transaction contains the wrapper
        const wrapper = data.transaction.transaction;
        actualTransaction = wrapper.transaction; // The actual transaction is nested deeper
        slot = data.transaction.slot;
        meta = wrapper.meta;
        // console.log(" Debug: GRPC format detected", {
        //   hasActualTransaction: !!actualTransaction,
        //   hasMeta: !!meta,
        //   slot: slot,
        //   wrapperKeys: wrapper ? Object.keys(wrapper) : 'no wrapper',
        //   metaType: typeof meta,
        //   metaKeys: meta ? Object.keys(meta) : 'no meta'
        // });
      } else if (data.transaction) {
        // Direct format
        actualTransaction = data.transaction;
        slot = data.slot;
        meta = data.meta || actualTransaction.meta;
        //console.log(" Debug: Direct format detected");
      } else {
        console.log(" No transaction object found");
        return null;
      }

      if (!actualTransaction) {
        console.log(" No actual transaction found");
        return null;
      }
      
      const formatted = {
        slot: slot,
        transaction: {
          message: actualTransaction.message,
          signatures: actualTransaction.signatures || [this.getTransactionSignature(data)],
        },
        meta: meta,
        version: data.version || 0,
        blockTime: data.blockTime || Math.floor(Date.now() / 1000),
      };

      console.log(" Transaction formatted successfully");
      
      return formatted;
    } catch (error) {
      console.error("Error formatting transaction:", error);
      return null;
    }
  }

  private extractPoolAccounts(instruction: any): PoolAccounts | null {
    try {
      const accounts = instruction.accounts;
      
      if (!accounts || accounts.length < 15) {
        console.error("Insufficient accounts in pool creation instruction");
        return null;
      }

      // Based on correct Meteora InitializePermissionlessConstantProductPoolWithConfig instruction account order
      return {
        pool: accounts[0].toString(),           // #1 Pool
        lpMint: accounts[2].toString(),         // #3 Lp Mint
        tokenMintA: accounts[3].toString(),     // #4 Token A Mint
        tokenMintB: accounts[4].toString(),     // #5 Token B Mint
        aVault: accounts[5].toString(),         // #6 A Vault
        bVault: accounts[6].toString(),         // #7 B Vault
        aTokenVault: accounts[7].toString(),    // #8 A Token Vault
        bTokenVault: accounts[8].toString(),    // #9 B Token Vault
        aVaultLpMint: accounts[9].toString(),   // #10 A Vault Lp Mint
        bVaultLpMint: accounts[10].toString(),  // #11 B Vault Lp Mint
        aVaultLp: accounts[11].toString(),      // #12 A Vault Lp
        bVaultLp: accounts[12].toString(),      // #13 B Vault Lp
        protocolTokenFee: accounts[14].toString(), // #15 Protocol Token Fee
      };
    } catch (error) {
      console.error("Error extracting pool accounts:", error);
      return null;
    }
  }

  public isTargetTransaction(transactionData: any): boolean {
    // Check for both pool creation and swap transactions involving target mint
    return this.isPoolCreationTransaction(transactionData) || this.isSwapTransaction(transactionData);
  }

  public isPoolCreationTransaction(transactionData: any): boolean {
    try {
      const formattedTxn = this.formatTransaction(transactionData);
      if (!formattedTxn || !formattedTxn.meta || formattedTxn.meta.err) {
        console.log(" Not a pool creation transaction (1)");
        return false;
      }

      //console.log(" Debug: Checking transaction for Meteora pool creation...");
      //console.log(" Meteora Program ID:", this.meteoraProgramId.toString());

      // Since we don't have a real parser, let's check the logs for Meteora activity
      if (formattedTxn.meta?.logMessages) {
        const meteoraLogs = formattedTxn.meta.logMessages.filter((log: string) => 
          (
            log.includes("InitializePermissionedPool") ||
            log.includes("InitializePermissionlessPool") ||
            log.includes("InitializePermissionlessConstantProductPoolWithConfig")
          )
        );

        // console.log(" Found Meteora logs:", meteoraLogs.length);
        // meteoraLogs.forEach((log: string, index: number) => {
        //   console.log(`  ${index + 1}: ${log}`);
        // });

        if (meteoraLogs.length > 0) {
          console.log(" Pool creation detected via log analysis");
          return true;
        }
      }

      // Fallback: Try to parse instructions (currently returns empty array)
      const parsedIxs = this.parser.parseTransactionData(
        formattedTxn.transaction.message,
        formattedTxn.meta.loadedAddresses
      );

      console.log(" Parsed instructions count:", parsedIxs.length);

      const meteoraIxs = parsedIxs.filter((ix) =>
        ix.programId.equals(this.meteoraProgramId)
      );

      const isPoolCreation = meteoraIxs.some((ix) => 
        ix.name === "initializePool" || 
        ix.name === "initializePermissionedPool" ||
        ix.name === "initializePermissionlessPool" ||
        ix.name === "InitializePermissionlessConstantProductPoolWithConfig"
      );

      console.log(" Pool creation via instruction parsing:", isPoolCreation);
      return isPoolCreation;
    } catch (error) {
      console.error(" Error in isPoolCreationTransaction:", error);
      return false;
    }
  }

  public getTransactionSignature(transactionData: any): string | null {
    try {
      // Check for GRPC stream format: transactionData.transaction.transaction.signature (Buffer)
      if (transactionData?.transaction?.transaction?.signature) {
        const sigBuffer = transactionData.transaction.transaction.signature;
        if (Buffer.isBuffer(sigBuffer)) {
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


}