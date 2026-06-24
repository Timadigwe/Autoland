import sqlite3 from 'sqlite3';
import path from 'path';

export class Database {
  private db: sqlite3.Database;

  constructor(dbPath: string = path.join(process.cwd(), 'autoland.db')) {
    this.db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Failed to open database:', err);
      }
    });
    this.init();
  }

  private init() {
    this.db.serialize(() => {
      // Table for tracking bundle lifecycles
      this.db.run(`
        CREATE TABLE IF NOT EXISTS lifecycles (
          bundle_id TEXT PRIMARY KEY,
          signatures TEXT,
          tip_lamports INTEGER,
          tip_account TEXT,
          attempt INTEGER,
          submitted_slot INTEGER,
          processed_slot INTEGER,
          confirmed_slot INTEGER,
          finalized_slot INTEGER,
          submitted_at INTEGER,
          processed_at INTEGER,
          confirmed_at INTEGER,
          finalized_at INTEGER,
          failure_type TEXT,
          failure_reason TEXT,
          confirmed_via TEXT
        )
      `);

      // Table for tracking AI decisions
      this.db.run(`
        CREATE TABLE IF NOT EXISTS ai_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bundle_id TEXT,
          timestamp INTEGER,
          event TEXT,
          decision TEXT,
          confidence TEXT,
          diagnosis TEXT,
          params TEXT
        )
      `);
    });
  }

  public recordLifecycle(entry: any) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO lifecycles (
        bundle_id, signatures, tip_lamports, tip_account, attempt,
        submitted_slot, processed_slot, confirmed_slot, finalized_slot,
        submitted_at, processed_at, confirmed_at, finalized_at,
        failure_type, failure_reason, confirmed_via
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.bundle_id,
      JSON.stringify(entry.signatures),
      entry.tip_lamports,
      entry.tip_account,
      entry.attempt,
      entry.stages?.submitted?.slot || null,
      entry.stages?.processed?.slot || null,
      entry.stages?.confirmed?.slot || null,
      entry.stages?.finalized?.slot || null,
      entry.stages?.submitted?.timestamp || null,
      entry.stages?.processed?.timestamp || null,
      entry.stages?.confirmed?.timestamp || null,
      entry.stages?.finalized?.timestamp || null,
      entry.failure?.type || null,
      entry.failure?.reason || null,
      entry.confirmed_via || null
    );
    stmt.finalize();
  }

  public recordDecision(bundleId: string, event: string, decision: any) {
    const stmt = this.db.prepare(`
      INSERT INTO ai_decisions (
        bundle_id, timestamp, event, decision, confidence, diagnosis, params
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      bundleId,
      Date.now(),
      event,
      decision.action,
      decision.confidence,
      decision.diagnosis,
      JSON.stringify(decision.params)
    );
    stmt.finalize();
  }

  public recordOutcome(bundleId: string, outcome: string) {
    const stmt = this.db.prepare(`
      UPDATE lifecycles SET failure_reason = ? WHERE bundle_id = ?
    `);
    stmt.run(outcome, bundleId);
    stmt.finalize();
  }

  public getRecentDropRate(limit: number = 5): Promise<number> {
    return new Promise((resolve) => {
      this.db.all(
        `SELECT failure_type FROM lifecycles ORDER BY submitted_at DESC LIMIT ?`,
        [limit],
        (err, rows: any[]) => {
          if (err || !rows || rows.length === 0) {
            resolve(0);
            return;
          }
          let dropped = 0;
          for (const row of rows) {
            if (row.failure_type) {
              dropped++;
            }
          }
          resolve(dropped / rows.length);
        }
      );
    });
  }
}

export const db = new Database();
