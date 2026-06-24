export type PositionState =
  | "NO_POSITION"
  | "IN_RANGE"
  | "DRIFT_DETECTED"
  | "REBALANCING"
  | "CONFIRMING"
  | "FAILED";

export type CommitmentStage = "submitted" | "processed" | "confirmed" | "finalized" | "failed";

export type FailureType =
  | "BlockhashStale"
  | "AuctionDropped"
  | "Underbid"
  | "SlippageExceeded"
  | "SimulationFailed"
  | "JitoBundleRejected"
  | "NetworkError"
  | "Transient"
  | "Unknown";

export type ExecutionPhase = "bundle_simulation" | "jito_submit" | "confirmation" | "build";

export type TxStep = "withdraw" | "swap" | "add" | "unknown";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface HealthSnapshot {
  rpcAvgLatencyMs: number | null;
  rpcRecentFailures: number;
  rpcLastError: string | null;
  jitoRecentAcceptRate: number | null;
  simulationRecentPassRate: number | null;
  grpcQueueDepth: number;
  grpcDroppedEvents: number;
  assessedAt: number;
}

export interface SessionMemorySummary {
  sessionId: string;
  startedAt: number;
  incidentCount: number;
  attemptCount: number;
  deferCount: number;
  errorTypesSeen: FailureType[];
  phasesSeen: ExecutionPhase[];
  mutationsTried: string[];
  attemptTimeline: AttemptTimelineEntry[];
  recentIncidents: Array<{
    id: string;
    phase: ExecutionPhase;
    errorType: FailureType;
    confidence: ConfidenceLevel;
    txStep?: TxStep;
    programErrorCode?: number;
  }>;
  recentDecisions: Array<{
    incidentId: string;
    action: ExecutionDecision["action"];
    reasoning: string;
    mutations: string[];
  }>;
  repeatedFailure: {
    errorType: FailureType;
    phase: ExecutionPhase;
    count: number;
  } | null;
}

export interface RebalanceTransaction {
  tx: import("@solana/web3.js").Transaction | import("@solana/web3.js").VersionedTransaction;
  signers: import("@solana/web3.js").Keypair[];
}

export interface TransactionLifecycleEvent {
  signature: string;
  stage: CommitmentStage;
  timestamp: number;
  slot?: number;
  tipAmountLamports?: number;
  failureReason?: string;
}

export interface ExecutionIncident {
  id: string;
  timestamp: number;
  sessionId: string;
  phase: ExecutionPhase;
  attempt: number;
  errorType: FailureType;
  errorMessage: string;
  confidence: ConfidenceLevel;
  txIndex?: number;
  txStep?: TxStep;
  txCount?: number;
  programErrorCode?: number;
  anchorErrorName?: string;
  simulationLogs?: string[];
  pool?: {
    activeBin?: number;
    centerBin?: number;
    driftBins: number;
  };
  tipPaidLamports: number;
  p90TipLamports: number;
  slippageBps: number;
  allowSwap: boolean;
  isColdStart: boolean;
  priorActions: string[];
  health: HealthSnapshot;
  sessionMemory: SessionMemorySummary;
  jitoInflightStatus?: string | null;
  grpcLastStage?: CommitmentStage | null;
  blockhashAgeMs?: number;
  bundleId?: string;
  phaseActionHint?: string;
  buildWarnings?: string[];
  logWarnings?: string[];
  situationBrief?: SituationBrief;
  attemptTimeline?: AttemptTimelineEntry[];
  programFailure?: ProgramFailureDetail;
  rawErr?: unknown;
  rawLogs?: string[];
}

export interface ProgramFailureDetail {
  programErrorCode?: number;
  anchorErrorName?: string;
  instructionIndex?: number;
  failingAccount?: string;
  rawErr: unknown;
  failureType: FailureType;
  humanReadable?: string;
  suggestedFix?: string;
  unparsed: boolean;
}

export interface ExecutionDecision {
  action: "RETRY" | "HALT" | "DEFER";
  reasoning: string;
  source?: "deterministic" | "agent" | "guardrail" | "preflight";
  diagnosis?: string;
  rootCause?: "underbid" | "slippage" | "network" | "pool_liquidity" | "blockhash" | "unknown";
  mutations?: {
    refreshBlockhash?: boolean;
    refreshStrategy?: boolean;
    overrideTipLamports?: number | null;
    slippageBps?: number | null;
    skipSwap?: boolean;
    waitMs?: number | null;
  };
}

export interface ConfirmationResult {
  status: CommitmentStage;
  signature: string;
  error?: unknown;
  failureType?: FailureType;
}

export interface BundleSubmissionResult {
  bundleId: string;
  signatures: string[];
  blockhash: string;
  blockhashFetchedAt: number;
  tipLamports: number;
  txCount: number;
}

export interface RebalanceBuildOptions {
  slippageBps?: number;
}

export interface AttemptTimelineEntry {
  attempt: number;
  buildActiveBin?: number;
  tipLamports?: number;
  slippageBps?: number;
  buildWarnings?: string[];
  funnel: Partial<{
    build: "ok" | "fail";
    preflight: "proceed" | "bump_tip" | "defer" | "rebuild";
    simulate: "pass" | "fail";
    jitoSubmit: "accepted" | "rejected";
    confirm: "landed" | "timeout" | "failed";
  }>;
  startedAt: number;
  endedAt?: number;
}

export interface SituationBrief {
  narrative: string;
  funnel: AttemptTimelineEntry["funnel"];
  tipMarket: {
    paid: number;
    p90: number;
    p99: number;
    recommended: number;
    samples: number;
    pctOfRecommended: number;
  };
  hypothesisCandidates: string[];
  mutationsAlreadyTried: string[];
  buildWarnings: string[];
  logWarnings: string[];
  healthDegraded: boolean;
  programFailure?: ExecutionIncident["programFailure"];
  rawErr?: unknown;
  rawLogs?: string[];
}

export interface IncidentOutcome {
  result: "success" | "failed" | "halted" | "deferred";
  winningMutations?: string[];
  resolvedAt: number;
}

export interface PreflightResult {
  action: "PROCEED" | "BUMP_TIP" | "DEFER" | "REBUILD";
  tipLamports: number;
  reasoning: string;
  waitMs?: number;
}

export interface BuildResult {
  transactions: RebalanceTransaction[];
  warnings: string[];
}
