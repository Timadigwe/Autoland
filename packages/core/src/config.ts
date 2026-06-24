import "dotenv/config";

/**
 * Central, typed configuration. Every value comes from the environment
 * (NFR-6). No secrets and — critically — no tip *values* are hardcoded here;
 * TIP_CEILING_LAMPORTS is a safety rail, not a tip (FR-9).
 */

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

function list(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export type Cluster = "mainnet-beta" | "devnet";

export const config = {
  cluster: opt("SOLANA_CLUSTER", "mainnet-beta") as Cluster,

  rpc: {
    http: req("RPC_URL"),
  },



  yellowstone: {
    url: req("GRPC_URL"),
    xToken: opt("X_TOKEN", ""),
  },

  jito: {
    blockEngineUrl: req("JITO_BLOCK_ENGINE_URL"),
    fallbacks: list("JITO_BLOCK_ENGINE_FALLBACKS"),
    tipFloorUrl: opt("JITO_TIP_FLOOR_URL", "https://bundles.jito.wtf/api/v1/bundles/tip_floor"),
  },

  wallet: {
    secretKey: opt("WALLET_SECRET_KEY", process.env.PRIVATE_KEYS ? process.env.PRIVATE_KEYS.split(",")[0] : ""), // optional until Phase 2
  },

  vllm: {
    url: opt("AI_RPC_URL", "https://api.cerebras.ai/v1"),
    apiKey: opt("AI_API_KEY", ""),
    model: opt("AI_MODEL", "llama3.1-8b"),
  },

  tips: {
    // Safety ceiling only. The actual tip is always derived from tip_floor.
    ceilingLamports: num("JITO_MAX_TIP_LAMPORTS", num("TIP_CEILING_LAMPORTS", 100_000)),
    floorLamports: num("JITO_MIN_TIP_LAMPORTS", 10_000),
  },

  stream: {
    queueMax: num("STREAM_QUEUE_MAX", 10_000),
    replayWindowSlots: num("STREAM_REPLAY_WINDOW_SLOTS", 150),
    pingIntervalMs: num("STREAM_PING_INTERVAL_MS", 15_000),
  },

  congestion: {
    ringSize: num("CONGESTION_RING_SIZE", 64),
  },
} as const;

export type Config = typeof config;
