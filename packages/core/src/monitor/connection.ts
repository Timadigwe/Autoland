import Yellowstone, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import type { default as ClientClass, SubscribeUpdate, SubscribeRequest } from "@triton-one/yellowstone-grpc";
import type { ClientDuplexStream } from "@grpc/grpc-js";
import bs58 from "bs58";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "../config.js";
import { logger } from "../common/logger.js";
import { resolveWorkspacePath } from "../common/paths.js";
import { PoolContentionTracker } from "./poolContention.js";
import { CompetitorTipTracker } from "./competitorTips.js";
import { JITO_TIP_ACCOUNTS } from "../common/constants.js";

const log = logger("stream");


const JITO_TIP_ACCOUNTS_BYTES = Array.from(JITO_TIP_ACCOUNTS).map(key => bs58.decode(key));

function equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export type Commitment = "processed" | "confirmed" | "finalized";

export interface SlotEvent {
  kind: "slot";
  slot: bigint;
  parent?: bigint;
  status: Commitment;
  ts: number;
}

export interface TxEvent {
  kind: "tx";
  signature: string;
  slot: bigint;
  isVote: boolean;
  failed: boolean;
  ts: number;
}

export type StreamEvent = SlotEvent | TxEvent;

export interface StreamMetrics {
  reconnects: number;
  droppedEvents: number;
  queueSize: number;
  enqueued: number;
  lastProcessedSlot: string;
  connected: boolean;
  lastEventAt: number;
}

function mapSlotStatus(status: number | undefined): Commitment {
  switch (status) {
    case CommitmentLevel.CONFIRMED:
      return "confirmed";
    case CommitmentLevel.FINALIZED:
      return "finalized";
    default:
      return "processed";
  }
}

export class BoundedQueue<T> {
  private buf: T[] = [];
  private waiters: Array<(v: T) => void> = [];
  private _dropped = 0;
  private _enqueued = 0;
  private closed = false;

  constructor(private readonly capacity: number) {}

  push(item: T): boolean {
    if (this.closed) return true;
    this._enqueued++;

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return true;
    }

    let dropped = false;
    if (this.buf.length >= this.capacity) {
      this.buf.shift();
      this._dropped++;
      dropped = true;
    }
    this.buf.push(item);
    return !dropped;
  }

  next(): Promise<T> {
    const item = this.buf.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (!this.closed) {
      yield await this.next();
    }
  }

  close() {
    this.closed = true;
  }

  get size(): number {
    return this.buf.length;
  }

  get dropped(): number {
    return this._dropped;
  }

  get enqueued(): number {
    return this._enqueued;
  }
}

export class SlotState {
  private last = 0n;
  private lastFlushed = 0n;
  private lastFlushAt = 0;

  constructor(
    private readonly path: string,
    private readonly flushEveryMs = 1000,
  ) {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        this.last = BigInt(raw.lastProcessedSlot ?? 0);
        this.lastFlushed = this.last;
      } catch {
        /* corrupt/empty */
      }
    }
  }

  get lastProcessedSlot(): bigint {
    return this.last;
  }

  observe(slot: bigint): void {
    if (slot > this.last) this.last = slot;
    const now = Date.now();
    if (now - this.lastFlushAt >= this.flushEveryMs && this.last !== this.lastFlushed) {
      this.flush();
    }
  }

  flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ lastProcessedSlot: this.last.toString() }));
    this.lastFlushed = this.last;
    this.lastFlushAt = Date.now();
  }
}

const Client = ((Yellowstone as any).default || Yellowstone) as typeof ClientClass;

export class StreamManager {
  readonly queue: BoundedQueue<StreamEvent>;
  private client: ClientClass;
  private stream?: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
  private state: SlotState;

  private pingTimer?: NodeJS.Timeout;
  private stopped = false;
  private reconnects = 0;
  private connected = false;
  private lastEventAt = 0;

  private seenSlots = new Set<string>();
  private seenSigs = new Set<string>();
  private seenOrder: string[] = [];

  private trackedAccounts: string[] = [];
  private targetPoolHex?: string;
  private targetPoolBytes?: Uint8Array;
  private trackedSignersHex = new Set<string>();
  private trackedSignersBytes: Uint8Array[] = [];

  private rawQueue: SubscribeUpdate[] = [];
  private processing = false;
  private trackedSignatures = new Set<string>();

  public contentionTracker?: PoolContentionTracker;
  public competitorTracker?: CompetitorTipTracker;

  constructor(statePath = resolveWorkspacePath("state/slot.json")) {
    this.queue = new BoundedQueue<StreamEvent>(config.stream.queueMax);
    this.state = new SlotState(statePath);
    this.client = new Client(config.yellowstone.url, config.yellowstone.xToken || undefined, {
      "grpc.max_receive_message_length": 64 * 1024 * 1024,
    });
  }

  trackAccounts(pubkeys: string[]): void {
    let changed = false;
    for (const k of pubkeys) {
      if (!this.trackedAccounts.includes(k)) {
        this.trackedAccounts.push(k);
        changed = true;
      }
      this.trackedSignersHex.add(Buffer.from(bs58.decode(k)).toString("hex"));
      const bytes = bs58.decode(k);
      if (!this.trackedSignersBytes.some((b) => equals(b, bytes))) {
        this.trackedSignersBytes.push(bytes);
      }
    }
    if (changed && this.connected && this.stream) {
      log.info("Updating active stream subscription with new tracked accounts...", { accounts: pubkeys });
      this.resubscribe().catch((err) => {
        log.error("Failed to resubscribe active stream after tracking accounts", { err: String(err) });
      });
    }
  }

  trackSignature(signature: string): void {
    if (this.trackedSignatures.has(signature)) return;
    this.trackedSignatures.add(signature);
    if (this.connected && this.stream) {
      log.info("Updating active stream subscription with new tracked signature...", { signature });
      this.resubscribe().catch((err) => {
        log.error("Failed to resubscribe active stream after tracking signature", { err: String(err) });
      });
    }
  }

  untrackSignature(signature: string): void {
    if (!this.trackedSignatures.has(signature)) return;
    this.trackedSignatures.delete(signature);
    if (this.connected && this.stream) {
      log.info("Updating active stream subscription to remove signature...", { signature });
      this.resubscribe().catch((err) => {
        log.error("Failed to resubscribe active stream after untracking signature", { err: String(err) });
      });
    }
  }

  trackPoolContention(poolAddress: string): void {
    let changed = false;
    this.targetPoolHex = Buffer.from(bs58.decode(poolAddress)).toString("hex");
    this.targetPoolBytes = bs58.decode(poolAddress);

    if (!this.trackedAccounts.includes(poolAddress)) {
      this.trackedAccounts.push(poolAddress);
      changed = true;
    }

    if (!this.contentionTracker) {
      this.contentionTracker = new PoolContentionTracker(poolAddress);
      log.info(`Now tracking contention for pool: ${poolAddress}`);
    }
    if (!this.competitorTracker) {
      this.competitorTracker = new CompetitorTipTracker(poolAddress);
      log.info(`Now tracking competitor tips for pool: ${poolAddress}`);
    }
    if (changed && this.connected && this.stream) {
      log.info("Updating active stream subscription with pool account...", { pool: poolAddress });
      this.resubscribe().catch((err) => {
        log.error("Failed to resubscribe active stream after tracking pool", { err: String(err) });
      });
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.state.flush();
    this.cleanupStream();
    this.queue.close();
    this.rawQueue = [];
  }

  metrics(): StreamMetrics {
    return {
      reconnects: this.reconnects,
      droppedEvents: this.queue.dropped,
      queueSize: this.queue.size,
      enqueued: this.queue.enqueued,
      lastProcessedSlot: this.state.lastProcessedSlot.toString(),
      connected: this.connected,
      lastEventAt: this.lastEventAt,
    };
  }

  private cleanupStream(): void {
    if (this.stream) {
      log.info("Cleaning up existing gRPC stream before reconnecting...");
      try {
        this.stream.removeAllListeners();
        this.stream.destroy();
      } catch (err) {
        log.warn("Error destroying previous stream", { err: String(err) });
      }
      this.stream = undefined;
    }
  }

  private async connect(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.cleanupStream();
        log.info("connecting", { url: config.yellowstone.url, fromSlot: this.state.lastProcessedSlot.toString() });
        this.stream = await this.client.subscribe();
        this.wireStream(this.stream);
        await this.resubscribe();
        this.connected = true;
        this.startPing();
        log.info("connected");
        return;
      } catch (err) {
        attempt++;
        this.connected = false;
        const backoff = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
        log.error("connect failed; backing off", { attempt, backoffMs: backoff, err: String(err) });
        await sleep(backoff);
      }
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      try {
        this.stream?.write(pingRequest());
      } catch (err) {
        log.warn("ping write failed", { err: String(err) });
      }
    }, config.stream.pingIntervalMs);
  }

  private async resubscribe(): Promise<void> {
    if (!this.stream) return;
    const from = this.state.lastProcessedSlot > 0n ? this.state.lastProcessedSlot : undefined;
    await writeReq(this.stream, combinedSubscribeRequest(from, this.trackedAccounts, Array.from(this.trackedSignatures)));
  }

  private wireStream(stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>): void {
    stream.on("data", (update: SubscribeUpdate) => this.enqueueUpdate(update));
    stream.on("error", (err) => {
      log.error("stream error", { err: String(err) });
      this.onDisconnect();
    });
    stream.on("end", () => {
      log.warn("stream ended");
      this.onDisconnect();
    });
    stream.on("close", () => {
      log.warn("stream closed");
      this.onDisconnect();
    });
  }

  private enqueueUpdate(update: SubscribeUpdate): void {
    this.rawQueue.push(update);
    this.triggerProcessing();
  }

  private triggerProcessing(): void {
    if (this.processing) return;
    this.processing = true;
    setImmediate(() => this.processQueue());
  }

  private processQueue(): void {
    if (this.stopped) {
      this.processing = false;
      return;
    }
    const batchSize = 100;
    const batch = this.rawQueue.splice(0, batchSize);

    for (const update of batch) {
      try {
        this.onUpdate(update);
      } catch (err) {
        log.error("Error processing stream update", { err: String(err) });
      }
    }

    if (this.rawQueue.length > 0) {
      setImmediate(() => this.processQueue());
    } else {
      this.processing = false;
    }
  }

  private reconnecting = false;
  private onDisconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this.connected = false;
    this.reconnects++;
    if (this.pingTimer) clearInterval(this.pingTimer);
    const backoff = Math.min(30_000, 500 * 2 ** Math.min(this.reconnects, 6));
    log.warn("reconnecting", { reconnects: this.reconnects, backoffMs: backoff });
    this.cleanupStream();
    setTimeout(() => {
      this.reconnecting = false;
      void this.connect();
    }, backoff);
  }

  private onUpdate(update: SubscribeUpdate): void {
    this.lastEventAt = Date.now();

    if (update.ping) {
      try {
        this.stream?.write(pingRequest());
      } catch {
        /* ignore */
      }
      return;
    }
    if (update.pong) return;

    if (update.slot) {
      const slot = BigInt(update.slot.slot);

      if (this.contentionTracker) {
        this.contentionTracker.updateSlot(slot);
      }
      if (this.competitorTracker) {
        this.competitorTracker.updateSlot(slot);
      }

      const status = mapSlotStatus(update.slot.status);
      const key = `${slot}|${status}`;
      if (this.dedupe(key)) return;
      this.state.observe(slot);
      const ev: SlotEvent = {
        kind: "slot",
        slot,
        parent: update.slot.parent != null ? BigInt(update.slot.parent) : undefined,
        status,
        ts: this.lastEventAt,
      };
      this.queue.push(ev);
      return;
    }

    if (update.transactionStatus) {
      const txStatus = update.transactionStatus;
      const sig = txStatus.signature ? bs58.encode(txStatus.signature) : undefined;
      const slotInt = BigInt(txStatus.slot);
      if (sig && this.trackedSignatures.has(sig)) {
        log.info(`[STREAM_DATA] Observed transactionStatus on signature at slot ${slotInt}: ${sig}`);
        const ev: TxEvent = {
          kind: "tx",
          signature: sig,
          slot: slotInt,
          isVote: false,
          failed: txStatus.err != null,
          ts: this.lastEventAt,
        };
        this.queue.push(ev);
      }
      return;
    }

    if (update.transaction) {
      const tx = update.transaction.transaction;
      const sig = tx?.signature ? bs58.encode(tx.signature) : undefined;
      const slotInt = BigInt(update.transaction.slot);

      if (tx && !tx.isVote) {
        const message = tx.transaction?.message;
        if (message) {
          const staticKeys = message.accountKeys || [];
          const loadedWritable = tx.meta?.loadedWritableAddresses || [];
          const loadedReadonly = tx.meta?.loadedReadonlyAddresses || [];
          const totalLength = staticKeys.length + loadedWritable.length + loadedReadonly.length;

          let interactsWithPool = false;
          let containsOurSigner = false;
          let jitoTipAccountIndex = -1;

          for (let i = 0; i < totalLength; i++) {
            let key: Uint8Array;
            if (i < staticKeys.length) {
              key = staticKeys[i];
            } else if (i < staticKeys.length + loadedWritable.length) {
              key = loadedWritable[i - staticKeys.length];
            } else {
              key = loadedReadonly[i - staticKeys.length - loadedWritable.length];
            }

            if (this.targetPoolBytes && equals(key, this.targetPoolBytes)) {
              interactsWithPool = true;
            }
            for (const signerBytes of this.trackedSignersBytes) {
              if (equals(key, signerBytes)) {
                containsOurSigner = true;
                break;
              }
            }
            for (let j = 0; j < JITO_TIP_ACCOUNTS_BYTES.length; j++) {
              if (equals(key, JITO_TIP_ACCOUNTS_BYTES[j])) {
                jitoTipAccountIndex = i;
                break;
              }
            }
          }

          if (interactsWithPool || containsOurSigner) {
            if (interactsWithPool) {
              log.info(`[STREAM_DATA] Observed transaction on pool/account at slot ${slotInt}: ${sig || '?'}`);

              if (this.contentionTracker) {
                this.contentionTracker.observeTransaction(slotInt);
              }
              if (this.competitorTracker) {
                this.competitorTracker.observeTransaction(slotInt, tx, jitoTipAccountIndex);
              }
            }

            if (sig) {
              const key = `tx|${sig}`;
              if (!this.dedupe(key)) {
                const ev: TxEvent = {
                  kind: "tx",
                  signature: sig,
                  slot: slotInt,
                  isVote: tx.isVote ?? false,
                  failed: tx.meta?.err != null,
                  ts: this.lastEventAt,
                };
                this.queue.push(ev);
              }
            }
          }
        }
      }
      return;
    }
  }

  private dedupe(key: string): boolean {
    const set = key.startsWith("tx|") ? this.seenSigs : this.seenSlots;
    if (set.has(key)) return true;
    set.add(key);
    this.seenOrder.push(key);
    const cap = config.stream.replayWindowSlots * 8;
    while (this.seenOrder.length > cap) {
      const old = this.seenOrder.shift()!;
      (old.startsWith("tx|") ? this.seenSigs : this.seenSlots).delete(old);
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function writeReq(
  stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>,
  req: SubscribeRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(req, (err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
}

function slotSubscribeRequest(fromSlot?: bigint): SubscribeRequest {
  return {
    accounts: {},
    slots: {
      all: { filterByCommitment: false },
    },
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.PROCESSED,
  };
}

function combinedSubscribeRequest(
  fromSlot?: bigint,
  accountIncludes: string[] = [],
  signatures: string[] = [],
): SubscribeRequest {
  const req = slotSubscribeRequest(fromSlot);
  if (accountIncludes.length > 0) {
    req.transactions = {
      mine: {
        vote: false,
        failed: undefined,
        accountInclude: accountIncludes,
        accountExclude: [],
        accountRequired: [],
      },
    };
  }
  if (signatures.length > 0) {
    req.transactionsStatus = {};
    for (const sig of signatures) {
      req.transactionsStatus[sig.slice(0, 16)] = {
        signature: sig,
        accountInclude: [],
        accountExclude: [],
        accountRequired: [],
      };
    }
  }
  return req;
}

function pingRequest(): SubscribeRequest {
  return {
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    ping: { id: 1 },
  };
}
