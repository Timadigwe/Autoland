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
      "DLMM_TARGET_POOL",
    ];

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
      }
    }

    const privateKeys = this.loadPrivateKeys();
    const strategy = (process.env.DLMM_STRATEGY || "Curve") as "Spot" | "Curve" | "BidAsk";
    if (!["Spot", "Curve", "BidAsk"].includes(strategy)) {
      throw new Error(`Invalid DLMM_STRATEGY: ${strategy}. Use Spot, Curve, or BidAsk.`);
    }

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
        cooldownSeconds: parseInt(process.env.JITO_COOLDOWN_SECONDS || "60", 10),
        minTipLamports: parseInt(process.env.JITO_MIN_TIP_LAMPORTS || "300000", 10),
        maxTipLamports: parseInt(process.env.JITO_MAX_TIP_LAMPORTS || "5000000", 10),
        tipMarginMultiplier: parseFloat(process.env.JITO_TIP_MARGIN_MULTIPLIER || "1.5"),
        maxSubmitRounds: parseInt(process.env.JITO_MAX_SUBMIT_ROUNDS || "3", 10),
        maxRetries: parseInt(process.env.MAX_EXECUTION_RETRIES || "3", 10),
        maxResubmitRounds: parseInt(process.env.JITO_MAX_RESUBMIT_ROUNDS || "4", 10),
        minSamplesBeforeExecution: parseInt(process.env.TIP_MIN_SAMPLES_BEFORE_EXECUTION || "50", 10),
        uuid: process.env.JITO_UUID || undefined,
      },
      trading: {
        maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || "500", 10),
        dryRun: process.env.DRY_RUN === "true",
        driftThresholdBins: parseInt(process.env.DRIFT_THRESHOLD_BINS || "5", 10),
        strategyBinCount: parseInt(process.env.STRATEGY_BIN_COUNT || "11", 10),
        solRentBuffer: parseFloat(process.env.SOL_RENT_BUFFER || "0.15"),
        swapBinArrayCount: parseInt(process.env.SWAP_BIN_ARRAY_COUNT || "8", 10),
        swapMaxExtraBinArrays: parseInt(process.env.SWAP_MAX_EXTRA_BIN_ARRAYS || "3", 10),
        maxPositionSizeX: process.env.MAX_POSITION_SIZE_X ? parseFloat(process.env.MAX_POSITION_SIZE_X) : undefined,
        maxPositionSizeY: process.env.MAX_POSITION_SIZE_Y ? parseFloat(process.env.MAX_POSITION_SIZE_Y) : undefined,
      },
      wallets: {
        privateKeys,
      },
      dlmm: {
        targetPool: process.env.DLMM_TARGET_POOL!,
        strategy,
      },

      engine: {
        pollIntervalMs: parseInt(process.env.ENGINE_POLL_INTERVAL_MS || "10000", 10),
        confirmationProcessedTimeoutMs: parseInt(process.env.CONFIRMATION_PROCESSED_TIMEOUT_MS || "8000", 10),
        confirmationHardTimeoutMs: parseInt(process.env.CONFIRMATION_HARD_TIMEOUT_MS || "60000", 10),
        confirmationAttemptTimeoutMs: parseInt(process.env.CONFIRMATION_ATTEMPT_TIMEOUT_MS || "15000", 10),
        blockhashStaleMs: parseInt(process.env.BLOCKHASH_STALE_MS || "58000", 10),
        preflightMinTipRatio: parseFloat(process.env.PREFLIGHT_MIN_TIP_RATIO || "0.8"),
        preflightMaxBinDrift: parseInt(process.env.PREFLIGHT_MAX_BIN_DRIFT || "2", 10),
      },
    };
  }

  private loadPrivateKeys(): string[] {
    if (process.env.PRIVATE_KEYS_FILE) {
      const filePath = path.resolve(process.env.PRIVATE_KEYS_FILE);

      if (!fs.existsSync(filePath)) {
        throw new Error(`Private keys file not found: ${filePath}`);
      }

      const fileContent = fs.readFileSync(filePath, "utf-8");
      const privateKeys = fileContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

      if (privateKeys.length === 0) {
        throw new Error(`No private keys found in file: ${filePath}`);
      }

      console.log(`Loaded ${privateKeys.length} private key(s) from ${filePath}`);
      return privateKeys;
    }

    if (process.env.PRIVATE_KEYS) {
      return process.env.PRIVATE_KEYS.split(",").map((key) => key.trim());
    }

    throw new Error("Either PRIVATE_KEYS_FILE or PRIVATE_KEYS environment variable must be set");
  }

  public getConfig(): BotConfig {
    return this.config;
  }
}
