import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { BotConfig } from "../types/config";

dotenv.config();

export class ConfigManager {
  private static instance: ConfigManager;
  private config: BotConfig;

  private constructor() {
    this.config = this.loadConfig();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private loadConfig(): BotConfig {
    const requiredEnvVars = [
      "RPC_URL",
      "GRPC_URL",
      "METEORA_PROGRAM_ID",
      "JITO_BLOCK_ENGINE_URL",
      "JITO_TIP_ACCOUNT",
      "DLMM_TARGET_POOL",
      "OPENROUTER_API_KEY"
    ];

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
      }
    }

    const privateKeys = this.loadPrivateKeys();

    return {
      rpc: {
        url: process.env.RPC_URL!,
      },
      grpc: {
        url: process.env.GRPC_URL!,
        token: process.env.X_TOKEN,
      },
      meteora: {
        programId: process.env.METEORA_PROGRAM_ID!,
      },
      jito: {
        blockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL!,
        tipAccount: process.env.JITO_TIP_ACCOUNT || "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
        singleTransactionPerBundle: process.env.JITO_SINGLE_TRANSACTION_PER_BUNDLE === "true",
      },
      trading: {
        tradeAmountSol: parseFloat(process.env.TRADE_AMOUNT_SOL || "0.01"),
        maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || "500"),
        priorityFeeMicroLamports: parseInt(process.env.PRIORITY_FEE_MICRO_LAMPORTS || "10000"),
        usePercentageOfBalance: process.env.USE_PERCENTAGE_OF_BALANCE === "true",
        balancePercentage: parseFloat(process.env.BALANCE_PERCENTAGE || "90"),
        dryRun: process.env.DRY_RUN === "true",
      },
      wallets: {
        privateKeys,
      },
      dlmm: {
        targetPool: process.env.DLMM_TARGET_POOL!,
      },
      ai: {
        openRouterApiKey: process.env.OPENROUTER_API_KEY!,
        model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3-8b-instruct:free",
      },
      simulation: {
        enabled: process.env.SIMULATION_ENABLED === "true",
        commitment: (process.env.SIMULATION_COMMITMENT as "processed" | "confirmed" | "finalized") || "confirmed",
        validateAccounts: process.env.SIMULATION_VALIDATE_ACCOUNTS !== "false",
        logDetails: process.env.SIMULATION_LOG_DETAILS !== "false",
        failOnSimulationError: process.env.SIMULATION_FAIL_ON_ERROR === "true",
      },
    };
  }

  private loadPrivateKeys(): string[] {
    if (process.env.PRIVATE_KEYS_FILE) {
      const filePath = path.resolve(process.env.PRIVATE_KEYS_FILE);
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`Private keys file not found: ${filePath}`);
      }
      
      try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const privateKeys = fileContent
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#'));
        
        if (privateKeys.length === 0) {
          throw new Error(`No private keys found in file: ${filePath}`);
        }
        
        console.log(`Loaded ${privateKeys.length} private keys from file: ${filePath}`);
        return privateKeys;
      } catch (error) {
        throw new Error(`Error reading private keys file: ${error}`);
      }
    } else if (process.env.PRIVATE_KEYS) {
      return process.env.PRIVATE_KEYS.split(",").map(key => key.trim());
    } else {
      throw new Error("Either PRIVATE_KEYS_FILE or PRIVATE_KEYS environment variable must be set");
    }
  }

  public getConfig(): BotConfig {
    return this.config;
  }

  public updateConfig(newConfig: Partial<BotConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}