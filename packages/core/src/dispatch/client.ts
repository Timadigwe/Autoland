import { config } from "../config.js";
import { logger } from "../common/logger.js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { findWorkspaceRoot } from "../common/paths.js";
import path from "node:path";

const log = logger("jito-client");

export type InflightStatus = "Invalid" | "Pending" | "Failed" | "Landed";

export interface InflightBundleStatus {
  bundle_id: string;
  status: InflightStatus;
  landed_slot: number | null;
}

export interface BundleStatus {
  bundle_id: string;
  transactions: string[];
  slot: number;
  confirmation_status: "processed" | "confirmed" | "finalized" | null;
  err: unknown;
}

export class JitoClient {
  constructor(
    private readonly baseUrl = config.jito.blockEngineUrl,
    private readonly fallbacks = config.jito.fallbacks,
  ) {}

  async getTipAccounts(): Promise<string[]> {
    return this.rpc<string[]>("/api/v1/bundles", "getTipAccounts", []);
  }

  async sendBundle(encodedTxs: string[], encoding: "base58" | "base64" = "base64"): Promise<string> {
    return this.rpc<string>("/api/v1/bundles", "sendBundle", [encodedTxs, { encoding }]);
  }

  async getInflightBundleStatuses(bundleIds: string[]): Promise<InflightBundleStatus[]> {
    const res = await this.rpc<{ value: InflightBundleStatus[] }>(
      "/api/v1/bundles",
      "getInflightBundleStatuses",
      [bundleIds],
    );
    return res.value ?? [];
  }

  async getBundleStatuses(bundleIds: string[]): Promise<BundleStatus[]> {
    const res = await this.rpc<{ value: BundleStatus[] }>(
      "/api/v1/bundles",
      "getBundleStatuses",
      [bundleIds],
    );
    return res.value ?? [];
  }

  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const endpoints = [this.baseUrl, ...this.fallbacks].slice(0, 3);
    let lastErr: unknown;
    for (const base of endpoints) {
      try {
        return await this.post<T>(base + path, method, params);
      } catch (err) {
        lastErr = err;
        log.warn("Jito RPC failed; trying next endpoint", { base, method, err: String(err) });
      }
    }
    throw new Error(`Jito RPC ${method} failed on all endpoints: ${String(lastErr)}`);
  }

  private async post<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { jsonrpc: "2.0"; id: number | string; result?: T; error?: { code: number; message: string; data?: unknown } };
    if (json.error) {
      throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
    }
    if (json.result === undefined) {
      throw new Error(`RPC ${method} returned no result`);
    }
    return json.result;
  }
}

let _client: JitoClient | undefined;
export function jitoClient(): JitoClient {
  if (!_client) _client = new JitoClient();
  return _client;
}

// ---- gRPC next leader client implementation ----

interface NextScheduledLeaderResponse {
  currentSlot: number | Long;
  nextLeaderSlot: number | Long;
  nextLeaderIdentity: string;
  nextLeaderRegion: string;
}

interface SearcherClient {
  GetNextScheduledLeader(
    request: { regions?: string[] },
    callback: (err: grpc.ServiceError | null, resp: NextScheduledLeaderResponse) => void,
  ): void;
  SubscribeBundleResults(
    request: Record<string, never>
  ): grpc.ClientReadableStream<any>;
}

type SearcherServiceConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => SearcherClient;

let _searcherClient: SearcherClient | undefined;

function getSearcherClient(): SearcherClient {
  if (_searcherClient) return _searcherClient;
  const url = new URL(config.jito.blockEngineUrl);
  const address = `${url.hostname}:443`;
  const root = findWorkspaceRoot();
  const PROTO_DIR = path.resolve(root, "packages/core/proto");
  const PROTO_PATH = path.join(PROTO_DIR, "searcher.proto");

  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as unknown as {
    searcher: { SearcherService: SearcherServiceConstructor };
  };

  _searcherClient = new proto.searcher.SearcherService(address, grpc.credentials.createSsl());
  log.info("gRPC searcher client created", { address });
  return _searcherClient;
}

export interface NextScheduledLeader {
  currentSlot: number;
  nextLeaderSlot: number;
  nextLeaderIdentity: string;
  nextLeaderRegion?: string;
}

export function getNextScheduledLeader(timeoutMs = 5000): Promise<NextScheduledLeader> {
  return new Promise((resolve, reject) => {
    const client = getSearcherClient();
    const deadline = new Date();
    deadline.setMilliseconds(deadline.getMilliseconds() + timeoutMs);

    client.GetNextScheduledLeader({ regions: [] }, (err, resp) => {
      if (err) {
        reject(new Error(`gRPC GetNextScheduledLeader failed: ${err.message}`));
        return;
      }
      resolve({
        currentSlot: Number(resp.currentSlot),
        nextLeaderSlot: Number(resp.nextLeaderSlot),
        nextLeaderIdentity: resp.nextLeaderIdentity,
        nextLeaderRegion: resp.nextLeaderRegion || undefined,
      });
    });
  });
}

export interface BundleResultEvent {
  bundle_id: string;
  result: {
    accepted?: { slot: number; validator_identity: string };
    rejected?: {
      simulation_failure?: { tx_signature: string; msg?: string };
      winning_batch_bid_rejected?: { msg?: string };
      state_auction_bid_rejected?: { msg?: string };
      internal_error?: { msg?: string };
      dropped_bundle?: { msg?: string };
    };
    finalized?: Record<string, never>;
    processed?: { validator_identity: string; slot: number };
    dropped?: { reason: string };
  };
}

export function subscribeBundleResults(
  onResult: (result: BundleResultEvent) => void,
  onError: (err: Error) => void
): () => void {
  const client = getSearcherClient();
  const stream = client.SubscribeBundleResults({});
  
  stream.on("data", (data: any) => {
    onResult(data);
  });
  
  stream.on("error", (err: any) => {
    onError(err);
  });
  
  return () => {
    try {
      stream.cancel();
    } catch { /* ignore */ }
  };
}
