import {
  Connection,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
  Keypair,
  SimulatedTransactionResponse,
  RpcResponseAndContext,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Logger } from "../utils/logger";
import { BotConfig } from "../types/config";

export interface SimulationResult {
  success: boolean;
  error?: string;
  logs?: string[];
  unitsConsumed?: number;
  err?: any;
  accounts?: any[];
  returnData?: any;
}

export interface SimulationConfig {
  replaceRecentBlockhash?: boolean;
  commitment?: "processed" | "confirmed" | "finalized";
  sigVerify?: boolean;
  minContextSlot?: number;
  signers?: Keypair[];
}

export class TransactionSimulator {
  private connection: Connection;
  private config: BotConfig;
  private logger: Logger;

  constructor(connection: Connection, config: BotConfig) {
    this.connection = connection;
    this.config = config;
    this.logger = Logger.getInstance();
  }

  public async simulateBuyTransaction(
    transaction: Transaction,
    wallet: Keypair,
    simulationConfig?: SimulationConfig
  ): Promise<SimulationResult> {
    try {
      this.logger.info(" Starting transaction simulation...");
      
      const defaultConfig: SimulationConfig = {
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        sigVerify: false,
        ...simulationConfig,
      };

      const { blockhash } = await this.connection.getLatestBlockhash(defaultConfig.commitment);
      transaction.recentBlockhash = blockhash;
      
      // If signers are provided, use partialSign to not overwrite existing signatures if any
      if (simulationConfig?.signers && simulationConfig.signers.length > 0) {
         transaction.signatures = []; // clear to prevent mismatched signatures if re-simulating
         simulationConfig.signers.forEach(signer => transaction.partialSign(signer));
      } else {
         transaction.sign(wallet);
      }

      this.logger.info(` Simulating transaction with ${transaction.instructions.length} instructions`);
      
      const simulationResult = await this.connection.simulateTransaction(transaction);

      return this.processSimulationResult(simulationResult);
    } catch (error) {
      this.logger.error(" Transaction simulation failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown simulation error",
      };
    }
  }

  public async simulateAndOptimize(
    transaction: Transaction,
    wallet: Keypair,
    additionalSigners: Keypair[] = []
  ): Promise<{ success: boolean; optimizedTransaction?: Transaction; error?: string }> {
    try {
      this.logger.info(" [SIMULATION] Running local RPC pre-flight simulation...");
      const allSigners = [wallet, ...additionalSigners];
      
      const result = await this.simulateBuyTransaction(transaction, wallet, { signers: allSigners });
      
      if (!result.success || result.error) {
        this.logger.error(` [SIMULATION] Failed! Transaction will revert on-chain. Reason: ${result.error}`);
        return { success: false, error: result.error };
      }
      
      const unitsConsumed = result.unitsConsumed || 1000000;
      // Add a 10% safety buffer to the actual compute used
      const optimizedLimit = Math.min(Math.ceil(unitsConsumed * 1.1), 1400000);
      
      this.logger.info(` [SIMULATION] Success. Used ${unitsConsumed} CUs. Injecting optimized limit of ${optimizedLimit} CUs...`);
      
      // We must insert the compute budget instruction at the VERY BEGINNING of the transaction
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: optimizedLimit,
      });
      
      // Create a fresh transaction with the compute budget instruction first
      const optimizedTx = new Transaction();
      optimizedTx.add(computeBudgetIx);
      
      // Filter out any existing compute budget limits to avoid conflicts
      transaction.instructions.forEach(ix => {
        if (!ix.programId.equals(ComputeBudgetProgram.programId)) {
          optimizedTx.add(ix);
        }
      });
      
      // Preserve fee payer and blockhash if they existed
      if (transaction.feePayer) optimizedTx.feePayer = transaction.feePayer;
      if (transaction.recentBlockhash) optimizedTx.recentBlockhash = transaction.recentBlockhash;

      // Ensure we explicitly sign the optimized transaction with ALL required signers
      optimizedTx.signatures = [];
      allSigners.forEach(signer => optimizedTx.partialSign(signer));

      return { success: true, optimizedTransaction: optimizedTx };
    } catch (e: any) {
      this.logger.error(" [SIMULATION] Unexpected error during simulation:", e);
      return { success: false, error: e.message || String(e) };
    }
  }

  public async simulateVersionedTransaction(
    transaction: VersionedTransaction,
    simulationConfig?: SimulationConfig
  ): Promise<SimulationResult> {
    try {
      this.logger.info(" Starting versioned transaction simulation...");
      
      const defaultConfig: SimulationConfig = {
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        sigVerify: false,
        ...simulationConfig,
      };

      this.logger.info(` Simulating versioned transaction`);
      
      const simulationResult = await this.connection.simulateTransaction(
        transaction
      );

      return this.processSimulationResult(simulationResult);
    } catch (error) {
      this.logger.error(" Versioned transaction simulation failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown simulation error",
      };
    }
  }

  private processSimulationResult(
    simulationResult: RpcResponseAndContext<SimulatedTransactionResponse>
  ): SimulationResult {
    const { value } = simulationResult;
    
    if (value.err) {
      this.logger.error(" Simulation failed with error:", value.err);
      
      // Show all logs when there's an error to help with debugging
      if (value.logs && value.logs.length > 0) {
        this.logger.error("📋 Simulation logs (for debugging):");
        value.logs.forEach((log, index) => {
          this.logger.error(`  ${index + 1}: ${log}`);
        });
      } else {
        this.logger.error("📋 No logs available for debugging");
      }
      
      return {
        success: false,
        error: JSON.stringify(value.err),
        logs: value.logs || [],
        unitsConsumed: value.unitsConsumed,
        err: value.err,
      };
    }

    this.logger.info(" Simulation successful");
    this.logger.info(` Compute units consumed: ${value.unitsConsumed || 0}`);
    
    if (value.logs && value.logs.length > 0) {
      this.logger.info("📋 Simulation logs:");
      value.logs.forEach((log, index) => {
        this.logger.info(`  ${index + 1}: ${log}`);
      });
    }

    return {
      success: true,
      logs: value.logs || [],
      unitsConsumed: value.unitsConsumed,
      accounts: value.accounts || [],
      returnData: value.returnData,
    };
  }

  public async validateTransactionAccounts(
    transaction: Transaction,
    wallet: Keypair
  ): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
      // Check if wallet has sufficient balance
      const balance = await this.connection.getBalance(wallet.publicKey);
      const estimatedFee = 5000; // Base fee estimate
      
      if (balance < estimatedFee) {
        issues.push(`Insufficient SOL balance: ${balance / 1e9} SOL (need at least ${estimatedFee / 1e9} SOL for fees)`);
      }

      // Check if all accounts exist (for non-system accounts)
      const accountKeys = transaction.instructions.flatMap(ix => 
        ix.keys.map(key => key.pubkey)
      );
      
      const uniqueKeys = [...new Set(accountKeys.map(key => key.toString()))];
      this.logger.info(` Validating ${uniqueKeys.length} unique accounts`);

      // Batch check account existence (limit to avoid RPC limits)
      const batchSize = 100;
      for (let i = 0; i < uniqueKeys.length; i += batchSize) {
        const batch = uniqueKeys.slice(i, i + batchSize);
        const accountInfos = await this.connection.getMultipleAccountsInfo(
          batch.map(key => new PublicKey(key))
        );
        
        accountInfos.forEach((info, index) => {
          if (info === null) {
            // This is expected for accounts that will be created during the transaction
            this.logger.debug(`Account ${batch[index]} does not exist (may be created during transaction)`);
          }
        });
      }

      return {
        valid: issues.length === 0,
        issues,
      };
    } catch (error) {
      issues.push(`Account validation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      return {
        valid: false,
        issues,
      };
    }
  }

  public async estimateTransactionFees(transaction: Transaction): Promise<number> {
    try {
      // Use the newer getFeeForMessage API
      const message = transaction.compileMessage();
      const feeForMessage = await this.connection.getFeeForMessage(message);
      return feeForMessage.value || 5000;
    } catch (error) {
      this.logger.warn("Failed to estimate transaction fees, using default:", error);
      return 5000; // Default fee estimate
    }
  }

  public async dryRunTransaction(
    transaction: Transaction,
    wallet: Keypair,
    options?: {
      validateAccounts?: boolean;
      logDetails?: boolean;
    }
  ): Promise<{
    simulation: SimulationResult;
    validation?: { valid: boolean; issues: string[] };
    estimatedFee?: number;
  }> {
    const opts = {
      validateAccounts: true,
      logDetails: true,
      ...options,
    };

    this.logger.info(" Starting dry run of buy transaction...");

    const result: any = {};

    // Simulate the transaction
    result.simulation = await this.simulateBuyTransaction(transaction, wallet);

    // Validate accounts if requested
    if (opts.validateAccounts) {
      result.validation = await this.validateTransactionAccounts(transaction, wallet);
    }

    // Estimate fees
    try {
      result.estimatedFee = await this.estimateTransactionFees(transaction);
    } catch (error) {
      this.logger.warn("Failed to estimate fees:", error);
    }

    if (opts.logDetails) {
      this.logDryRunResults(result);
    }

    return result;
  }

  private logDryRunResults(results: any): void {
    this.logger.info("📊 Dry Run Results:");
    this.logger.info("==================");
    
    if (results.simulation) {
      this.logger.info(` Simulation: ${results.simulation.success ? "SUCCESS" : "FAILED"}`);
      if (results.simulation.unitsConsumed) {
        this.logger.info(` Compute Units: ${results.simulation.unitsConsumed}`);
      }
      if (results.simulation.error) {
        this.logger.error(` Error: ${results.simulation.error}`);
      }
      
      // Show logs for failed simulations in dry run results
      if (!results.simulation.success && results.simulation.logs && results.simulation.logs.length > 0) {
        this.logger.info("📋 Error logs:");
        results.simulation.logs.slice(0, 10).forEach((log: string, index: number) => {
          this.logger.info(`  ${index + 1}: ${log}`);
        });
        if (results.simulation.logs.length > 10) {
          this.logger.info(`  ... and ${results.simulation.logs.length - 10} more logs`);
        }
      }
    }

    if (results.validation) {
      this.logger.info(` Validation: ${results.validation.valid ? "PASSED" : "FAILED"}`);
      if (results.validation.issues.length > 0) {
        this.logger.warn("⚠️ Issues found:");
        results.validation.issues.forEach((issue: string) => {
          this.logger.warn(`  - ${issue}`);
        });
      }
    }

    if (results.estimatedFee) {
      this.logger.info(` Estimated Fee: ${results.estimatedFee / 1e9} SOL`);
    }

    this.logger.info("==================");
  }
}
