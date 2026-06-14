import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RequestRecord } from "../types.js";
import type { McpEvent } from "../session.js";

export interface Store {
  insertRequest(rec: RequestRecord): void;
  insertMcp(ev: McpEvent): void;
  /** Total non-blocked spend for an ISO date (YYYY-MM-DD). */
  dailyTotal(date: string): number;
  recentRequests(n: number): RequestRecord[];
  recentMcp(n: number): McpEvent[];
}

/**
 * Open the SQLite-backed history store using Node's built-in `node:sqlite`
 * (Node 22+). Returns null if unavailable, so the proxy still runs fully
 * in-memory on older runtimes — persistence is an enhancement, never required.
 */
export async function openStore(path: string): Promise<Store | null> {
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as any;
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, ts INTEGER, day TEXT, provider TEXT, model TEXT,
        input INTEGER, output INTEGER, cost REAL, blocked INTEGER,
        block_reason TEXT, secrets TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_requests_day ON requests(day);
      CREATE TABLE IF NOT EXISTS mcp_events (
        ts INTEGER, server TEXT, direction TEXT, method TEXT, action TEXT, secrets TEXT
      );
    `);

    const insReq = db.prepare(
      `INSERT OR REPLACE INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insMcp = db.prepare(`INSERT INTO mcp_events VALUES (?,?,?,?,?,?)`);
    const sumDay = db.prepare(`SELECT COALESCE(SUM(cost),0) AS t FROM requests WHERE day = ? AND blocked = 0`);
    const recReq = db.prepare(`SELECT * FROM requests ORDER BY ts DESC LIMIT ?`);
    const recMcp = db.prepare(`SELECT * FROM mcp_events ORDER BY ts DESC LIMIT ?`);

    const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

    return {
      insertRequest(r) {
        insReq.run(
          r.id, r.ts, day(r.ts), r.provider, r.model,
          r.usage.inputTokens, r.usage.outputTokens, r.costUsd,
          r.blocked ? 1 : 0, r.blockReason ?? null, JSON.stringify(r.secrets),
        );
      },
      insertMcp(e) {
        insMcp.run(e.ts, e.server, e.direction, e.method ?? null, e.action, JSON.stringify(e.secrets));
      },
      dailyTotal(date) {
        return (sumDay.get(date) as any)?.t ?? 0;
      },
      recentRequests(n) {
        return (recReq.all(n) as any[]).map((row) => ({
          id: row.id, ts: row.ts, provider: row.provider, model: row.model,
          usage: { inputTokens: row.input, outputTokens: row.output },
          costUsd: row.cost, blocked: !!row.blocked,
          blockReason: row.block_reason ?? undefined,
          secrets: safeParse(row.secrets),
        })) as RequestRecord[];
      },
      recentMcp(n) {
        return (recMcp.all(n) as any[]).map((row) => ({
          ts: row.ts, server: row.server, direction: row.direction,
          method: row.method ?? undefined, action: row.action, secrets: safeParse(row.secrets),
        })) as McpEvent[];
      },
    };
  } catch {
    return null;
  }
}

function safeParse(s: string): any[] {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}
