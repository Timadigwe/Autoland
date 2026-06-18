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

export interface WalletInfo {
  keypair: any;
  publicKey: string;
  solBalance: number;
}