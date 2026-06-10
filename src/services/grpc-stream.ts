import Client, {
  CommitmentLevel,
  SubscribeRequestFilterTransactions,
} from "@triton-one/yellowstone-grpc";
import { PublicKey } from "@solana/web3.js";
import { BotConfig } from "../types/config";

interface SubscribeRequest {
  accounts: { [key: string]: any };
  slots: { [key: string]: any };
  transactions: { [key: string]: SubscribeRequestFilterTransactions };
  transactionsStatus: { [key: string]: any };
  blocks: { [key: string]: any };
  blocksMeta: { [key: string]: any };
  entry: { [key: string]: any };
  commitment?: CommitmentLevel;
  accountsDataSlice: any[];
  ping?: any;
}

export class GrpcStreamService {
  private client: Client;
  private config: BotConfig;
  private isStreaming: boolean = false;
  private activeStream: any = null;
  private currentRequest: SubscribeRequest | null = null;
  private pendingSignatures: Set<string> = new Set();

  constructor(config: BotConfig) {
    this.config = config;
    this.client = new Client(
      config.grpc.url,
      config.grpc.token,
      undefined
    );
  }

  public async startStream(
    onTransaction: (data: any) => void,
    onSlot?: (data: any) => void,
    onTransactionStatus?: (data: any) => void,
    onAccount?: (data: any) => void
  ): Promise<void> {
    if (this.isStreaming) {
      console.log("Stream is already running");
      return;
    }

    console.log("Starting GRPC stream for Meteora transactions...");
    console.log(` GRPC URL: ${this.config.grpc.url}`);
    console.log(` GRPC Token: ${this.config.grpc.token ? 'Present' : 'Missing'}`);
    this.isStreaming = true;

    const meteoraProgramId = new PublicKey(this.config.meteora.programId);

    // Build account include list - always include Meteora program
    let accountInclude: string[] = [];
    let accountRequired: string[] = [meteoraProgramId.toBase58()];


    // Add target  pool to include list if specified
    if (this.config.dlmm.targetPool && this.config.dlmm.targetPool.trim() !== '') {
      accountInclude = [this.config.dlmm.targetPool];

      console.log(` GRPC stream filtering for target pool: ${this.config.dlmm.targetPool}`);
    } else {
      accountInclude = [meteoraProgramId.toBase58()];
      console.log("No target mint specified - monitoring all Meteora transactions");
    }



    console.log(` GRPC Stream Config:`);
    console.log(`   - Meteora Program: ${meteoraProgramId.toBase58()}`);
    console.log(`   - Account Include: ${JSON.stringify(accountInclude)}`);
    console.log(`   - Account Required: ${JSON.stringify(accountRequired)}`);
    console.log(`   - Commitment: PROCESSED`);

    const JITO_TIP_ACCOUNTS = [
      "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
      "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
      "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
      "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
      "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
      "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
      "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
      "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"
    ];

    const req: SubscribeRequest = {
      accounts: {
        tipAccounts: {
          account: JITO_TIP_ACCOUNTS
        }
      },
      slots: {
        slotSub: {}
      },
      transactions: {
        meteora: {
          vote: false,
          failed: false,
          signature: undefined,
          accountInclude,
          accountExclude: [],
          accountRequired,
        },
      },
      transactionsStatus: {
        statusSub: {
          signature: Array.from(this.pendingSignatures)
        }
      },
      entry: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      ping: undefined,
      commitment: CommitmentLevel.PROCESSED,
    };

    this.currentRequest = req;

    while (this.isStreaming) {
      try {
        await this.handleStream(req, onTransaction, onSlot, onTransactionStatus, onAccount);
      } catch (error) {
        console.error("Stream error, restarting in 1 second...", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleStream(
    args: SubscribeRequest,
    onTransaction: (data: any) => void,
    onSlot?: (data: any) => void,
    onTransactionStatus?: (data: any) => void,
    onAccount?: (data: any) => void
  ): Promise<void> {
    console.log(" Attempting to connect to GRPC stream...");
    this.activeStream = await this.client.subscribe();
    console.log(" GRPC stream connection established");

    const streamClosed = new Promise<void>((resolve, reject) => {
      this.activeStream.on("error", (error: any) => {
        console.log("Stream ERROR:", error);
        reject(error);
        this.activeStream.end();
      });
      this.activeStream.on("end", () => {
        resolve();
      });
      this.activeStream.on("close", () => {
        resolve();
      });
    });

    this.activeStream.on("data", (data: any) => {
      if (data?.transaction && this.isStreaming) {
        onTransaction(data);
      } else if (data?.slot && this.isStreaming && onSlot) {
        onSlot(data);
      } else if (data?.transactionStatus && this.isStreaming && onTransactionStatus) {
        onTransactionStatus(data);
      } else if (data?.account && this.isStreaming && onAccount) {
        onAccount(data);
      }
    });

    await new Promise<void>((resolve, reject) => {
      console.log(" Writing subscription request to stream...");
      this.activeStream.write(args, (err: any) => {
        if (err === null || err === undefined) {
          console.log(" Subscription request sent successfully");
          resolve();
        } else {
          console.error(" Subscription request failed:", err);
          reject(err);
        }
      });
    }).catch((reason) => {
      console.error("Stream write error:", reason);
      throw reason;
    });

    console.log("⏳ Waiting for GRPC transactions...");

    await streamClosed;
  }

  public stopStream(): void {
    console.log("Stopping GRPC stream...");
    this.isStreaming = false;
    if (this.activeStream) {
      this.activeStream.end();
      this.activeStream = null;
    }
  }

  public isStreamActive(): boolean {
    return this.isStreaming;
  }

  public subscribeToTransaction(signature: string): void {
    if (!this.activeStream || !this.currentRequest) return;

    this.pendingSignatures.add(signature);

    // Update the request object
    this.currentRequest.transactionsStatus = {
      statusSub: {
        signature: Array.from(this.pendingSignatures)
      }
    };

    // Write updated request to active stream
    console.log(` Adding dynamic stream subscription for signature: ${signature}`);
    this.activeStream.write(this.currentRequest);
  }

  public unsubscribeFromTransaction(signature: string): void {
    if (!this.activeStream || !this.currentRequest) return;

    this.pendingSignatures.delete(signature);

    this.currentRequest.transactionsStatus = {
      statusSub: {
        signature: Array.from(this.pendingSignatures)
      }
    };

    this.activeStream.write(this.currentRequest);
  }
}