import type { DetectedSecret, RequestRecord } from "./types.js";
import type { Store } from "./store/db.js";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface McpEvent {
  ts: number;
  server: string;
  direction: "agent→server" | "server→agent";
  method?: string;
  action: "redact" | "warn";
  secrets: DetectedSecret[];
}

/**
 * In-memory store for the life of one proxy process. Tracks spend (session
 * total + per-day) and a rolling log of requests. SQLite persistence is a
 * later milestone; the kill-switch only needs in-memory state.
 */
export class Session {
  readonly startedAt = Date.now();
  private sessionCost = 0;
  private dailyCost: Record<string, number> = {};
  private records: RequestRecord[] = [];

  /** Extra USD granted via `blackbox allow --more`, lifts the ceiling. */
  sessionGrant = 0;
  dailyGrant = 0;

  blockedCount = 0;
  secretBlockCount = 0;
  mcpSecretCount = 0;
  private mcpEvents: McpEvent[] = [];

  constructor(private store?: Store) {
    if (store) {
      // Per-day spend survives restarts so the daily kill-switch can't be
      // bypassed by bouncing the proxy.
      this.dailyCost[today()] = store.dailyTotal(today());
      this.records = store.recentRequests(100).reverse();
      this.mcpEvents = store.recentMcp(100).reverse();
    }
  }

  addRecord(rec: RequestRecord) {
    this.records.push(rec);
    if (this.records.length > 1000) this.records.shift();
    if (rec.blocked) this.blockedCount++;
    if (!rec.blocked) {
      this.sessionCost += rec.costUsd;
      this.dailyCost[today()] = (this.dailyCost[today()] ?? 0) + rec.costUsd;
    }
    this.store?.insertRequest(rec);
  }

  noteSecretBlock() {
    this.secretBlockCount++;
  }

  addMcpEvent(ev: McpEvent) {
    this.mcpEvents.push(ev);
    if (this.mcpEvents.length > 500) this.mcpEvents.shift();
    this.mcpSecretCount += ev.secrets.length;
    this.store?.insertMcp(ev);
  }

  recentMcp(n = 50): McpEvent[] {
    return this.mcpEvents.slice(-n).reverse();
  }

  get sessionTotal() {
    return this.sessionCost;
  }

  get dailyTotal() {
    return this.dailyCost[today()] ?? 0;
  }

  grantExtra(usd: number) {
    this.sessionGrant += usd;
    this.dailyGrant += usd;
  }

  recent(n = 50): RequestRecord[] {
    return this.records.slice(-n).reverse();
  }

  status() {
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      sessionTotal: this.sessionCost,
      dailyTotal: this.dailyTotal,
      requests: this.records.length,
      blocked: this.blockedCount,
      secretsBlocked: this.secretBlockCount,
      mcpSecrets: this.mcpSecretCount,
    };
  }
}
