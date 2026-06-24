export interface BotConfig {
  rpc: {
    url: string;
  };
  grpc: {
    url: string;
    token?: string;
  };
  meteora: {
    programId: string;
  };
  jito: {
    cooldownSeconds: number;
    minTipLamports: number;
    maxTipLamports: number;
    tipMarginMultiplier: number;
    maxSubmitRounds: number;
    maxRetries: number;
    maxResubmitRounds: number;
    minSamplesBeforeExecution: number;
    uuid?: string;
  };
  trading: {
    maxSlippageBps: number;
    dryRun: boolean;
    driftThresholdBins: number;
    strategyBinCount: number;
    solRentBuffer: number;
    swapBinArrayCount: number;
    swapMaxExtraBinArrays: number;
    maxPositionSizeX?: number;
    maxPositionSizeY?: number;
  };
  wallets: {
    privateKeys: string[];
  };
  dlmm: {
    targetPool: string;
    strategy: "Spot" | "Curve" | "BidAsk";
  };

  engine: {
    pollIntervalMs: number;
    confirmationProcessedTimeoutMs: number;
    confirmationHardTimeoutMs: number;
    confirmationAttemptTimeoutMs: number;
    blockhashStaleMs: number;
    preflightMinTipRatio: number;
    preflightMaxBinDrift: number;
  };
}

export interface WalletInfo {
  keypair: import("@solana/web3.js").Keypair;
  publicKey: string;
  solBalance: number;
}
