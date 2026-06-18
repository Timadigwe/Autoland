import * as fs from 'fs';
import * as path from 'path';

export type CommitmentStage = 'submitted' | 'processed' | 'confirmed' | 'finalized' | 'failed';

export interface TransactionLifecycleEvent {
  signature: string;
  stage: CommitmentStage;
  timestamp: number;
  slot?: number;
  tipAmountLamports?: number;
  failureReason?: string;
}

export class LifecycleTracker {
  private logFilePath: string;
  private transactionStartTimes: Map<string, number> = new Map();
  private transactionLogs: Map<string, TransactionLifecycleEvent[]> = new Map();

  constructor() {
    const logDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFilePath = path.join(logDir, 'lifecycle-log.jsonl');
  }

  public recordEvent(event: TransactionLifecycleEvent): void {
    const now = Date.now();

    if (event.stage === 'submitted') {
      this.transactionStartTimes.set(event.signature, now);
      this.transactionLogs.set(event.signature, [event]);
      console.log(`[Lifecycle] Transaction submitted: ${event.signature} (Tip: ${event.tipAmountLamports} lamports)`);
    } else {
      const logs = this.transactionLogs.get(event.signature) || [];
      logs.push(event);
      this.transactionLogs.set(event.signature, logs);

      const startTime = this.transactionStartTimes.get(event.signature) || now;
      const latencyMs = now - startTime;

      if (event.stage === 'failed') {
        console.error(`[Lifecycle] Transaction failed: ${event.signature} - Reason: ${event.failureReason} (Latency: ${latencyMs}ms)`);
      } else {
        console.log(`[Lifecycle] Transaction ${event.stage} at slot ${event.slot}: ${event.signature} (Latency: ${latencyMs}ms)`);
      }
    }


    this.writeToLog(event);
  }

  private writeToLog(event: TransactionLifecycleEvent): void {
    try {
      const logEntry = JSON.stringify({
        ...event,
        isoTimestamp: new Date(event.timestamp).toISOString()
      }) + '\n';

      fs.appendFileSync(this.logFilePath, logEntry);
    } catch (err) {
      console.error(`Failed to write to lifecycle log: ${err}`);
    }
  }

  public getLatency(signature: string, stage: CommitmentStage): number | null {
    const logs = this.transactionLogs.get(signature);
    if (!logs) return null;

    const startEvent = logs.find(l => l.stage === 'submitted');
    const stageEvent = logs.find(l => l.stage === stage);

    if (startEvent && stageEvent) {
      return stageEvent.timestamp - startEvent.timestamp;
    }
    return null;
  }

  public getRecentPerformance(limit: number = 5): Array<{ tipAmountLamports: number, stage: string }> {
    const results: Array<{ tipAmountLamports: number, stage: string }> = [];
    const signatures = Array.from(this.transactionLogs.keys()).slice(-limit);
    
    for (const sig of signatures) {
      const logs = this.transactionLogs.get(sig);
      if (logs && logs.length > 0) {
        const startEvent = logs.find(l => l.stage === 'submitted');
        const finalEvent = logs.find(l => l.stage === 'confirmed' || l.stage === 'failed');
        
        if (startEvent && startEvent.tipAmountLamports !== undefined && finalEvent) {
          results.push({
            tipAmountLamports: startEvent.tipAmountLamports,
            stage: finalEvent.stage
          });
        }
      }
    }
    
    return results;
  }
}
