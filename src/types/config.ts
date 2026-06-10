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
    blockEngineUrl: string;
    tipAccount: string;
    uuid: string;
    singleTransactionPerBundle: boolean;
  };
  trading: {
    tradeAmountSol: number;
    maxSlippageBps: number;
    priorityFeeMicroLamports: number;
    usePercentageOfBalance: boolean;
    balancePercentage: number;
    dryRun: boolean;
  };
  wallets: {
    privateKeys: string[];
  };
  dlmm: {
    targetPool: string;
  };
  ai: {
    openRouterApiKey: string;
    model: string;
  };
  simulation: {
    enabled: boolean;
    commitment: "processed" | "confirmed" | "finalized";
    validateAccounts: boolean;
    logDetails: boolean;
    failOnSimulationError: boolean;
  };
}

export interface PoolAccounts {
  pool: string;
  lpMint: string;
  tokenMintA: string;
  tokenMintB: string;
  aVault: string;
  bVault: string;
  aTokenVault: string;
  bTokenVault: string;
  aVaultLp: string;
  bVaultLp: string;
  aVaultLpMint: string;
  bVaultLpMint: string;
  protocolTokenFee: string;
}

export interface WalletInfo {
  keypair: any;
  publicKey: string;
  solBalance: number;
}

export interface TradeTarget {
  poolAccounts: PoolAccounts;
  timestamp: number;
}