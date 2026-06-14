import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Config, DetectedSecret, ProviderId, RequestRecord } from "./types.js";
import { Session } from "./session.js";
import { createScanner, scanRequestBody, type SecretScanner } from "./enforce/secrets.js";
import { checkBudget } from "./enforce/budget.js";
import {
  detectProvider,
  upstreamFor,
  computeCost,
  usageFromJson,
  StreamUsageAccumulator,
} from "./providers.js";
import { SSEParser } from "./sse.js";
import { log, usd } from "./log.js";
import { renderDashboard } from "./dashboard/page.js";

const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade",
  "accept-encoding", // force identity so we can always parse usage
]);

export interface BlackBox {
  server: http.Server;
  session: Session;
}

export function createServer(config: Config, store?: import("./store/db.js").Store): BlackBox {
  const session = new Session(store);
  const scanner = createScanner(config.secrets);

  const server = http.createServer((req, res) => {
    handle(req, res, config, session, scanner).catch((err) => {
      log.warn(`proxy error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `blackbox upstream error: ${(err as Error).message}` } }));
      } else {
        res.end();
      }
    });
  });

  return { server, session };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function blockResponse(res: http.ServerResponse, provider: ProviderId, message: string) {
  const status = 403;
  const body =
    provider === "anthropic"
      ? { type: "error", error: { type: "blocked_by_blackbox", message } }
      : { error: { message, type: "blocked_by_blackbox", code: "blocked_by_blackbox" } };
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config,
  session: Session,
  scanner: SecretScanner,
) {
  const url = req.url ?? "/";

  // ── Local control-plane routes ────────────────────────────────────────
  if (url.startsWith("/__blackbox")) {
    return handleControlPlane(req, res, url, session, config);
  }

  const provider = detectProvider(url, req.headers, config.providers);
  if (!provider) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "blackbox: no provider matched this route" } }));
    return;
  }

  const rawBody = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
  let outBody: Buffer = rawBody;
  let model = "unknown";
  let secrets: DetectedSecret[] = [];

  // Parse JSON body (best-effort) for inspection + model id.
  let parsed: any = null;
  if (rawBody.length && /application\/json/i.test(req.headers["content-type"] ?? "")) {
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
      if (parsed?.model) model = parsed.model;
    } catch {
      /* leave parsed null; forward raw */
    }
  }

  // ── Enforcement 1: secret/PII scan (pre-flight) ───────────────────────
  if (parsed) {
    secrets = scanRequestBody(scanner, parsed);
    if (secrets.length) {
      if (config.secrets.action === "block") {
        session.noteSecretBlock();
        record(session, { provider, model, blocked: true, blockReason: "secret", secrets });
        const list = secrets.map((s) => `${s.type} @ ${s.where}`).join(", ");
        log.block(`secret leak prevented → ${list}`);
        return blockResponse(
          res,
          provider,
          `🛡️ Agent Black Box blocked this request: it contained ${secrets.length} secret(s) — ${list}. ` +
            `Remove the secret, or set secrets.action to "redact"/"warn" in .blackbox.json.`,
        );
      }
      if (config.secrets.action === "redact") {
        log.warn(`redacted ${secrets.length} secret(s) before forwarding`);
      } else {
        log.warn(`secret(s) detected (warn mode): ${secrets.map((s) => s.type).join(", ")}`);
      }
    }
  }

  // Build the outbound body: optionally force OpenAI to report streaming usage
  // (Cursor/Codex often omit it → we'd otherwise see $0), then redact if needed.
  if (parsed) {
    let mutated = false;
    if (provider === "openai" && parsed.stream === true && !parsed.stream_options?.include_usage) {
      parsed.stream_options = { ...(parsed.stream_options ?? {}), include_usage: true };
      mutated = true;
    }
    const needRedact = secrets.length > 0 && config.secrets.action === "redact";
    if (needRedact) {
      const text = mutated ? JSON.stringify(parsed) : rawBody.toString("utf8");
      outBody = Buffer.from(scanner.redact(text), "utf8");
    } else if (mutated) {
      outBody = Buffer.from(JSON.stringify(parsed), "utf8");
    }
  }

  // ── Enforcement 2: budget kill-switch (pre-flight) ────────────────────
  const verdict = checkBudget(session, config.budget);
  if (verdict.level === "block") {
    record(session, { provider, model, blocked: true, blockReason: "budget", secrets });
    log.block(`💀 ${verdict.reason} — run \`blackbox allow --more <usd>\` to continue`);
    return blockResponse(
      res,
      provider,
      `💀 Agent Black Box budget kill-switch: ${verdict.reason}. ` +
        `The agent was halted to prevent runaway spend. Raise the limit in .blackbox.json or grant more budget.`,
    );
  } else if (verdict.level === "warn" && verdict.reason) {
    log.warn(verdict.reason);
  }

  // ── Forward upstream + account ────────────────────────────────────────
  await forward(req, res, provider, url, outBody, session, model, secrets);
}

async function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  provider: ProviderId,
  path: string,
  body: Buffer,
  session: Session,
  reqModel: string,
  secrets: DetectedSecret[],
) {
  const target = upstreamFor(provider) + path;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  headers.set("accept-encoding", "identity");

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    body: body.length ? new Uint8Array(body) : undefined,
  };
  if (body.length) init.duplex = "half";
  const upstream = await fetch(target, init);

  // Mirror status + headers (minus ones that conflict with our re-streaming).
  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (["content-length", "transfer-encoding", "connection"].includes(key)) return;
    outHeaders[key] = value;
  });
  res.writeHead(upstream.status, outHeaders);

  const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  const acc = new StreamUsageAccumulator(provider);
  const sse = new SSEParser();
  const decoder = new TextDecoder();
  let jsonText = "";

  if (!upstream.body) {
    res.end();
  } else {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value)); // pass bytes through untouched
      const text = decoder.decode(value, { stream: true });
      if (isStream) {
        for (const ev of sse.push(text)) acc.feed(ev);
      } else {
        jsonText += text;
      }
    }
    res.end();
  }

  // Resolve usage → cost, then record.
  let usage = isStream ? acc.result() : null;
  if (!isStream && jsonText) {
    try {
      usage = usageFromJson(provider, JSON.parse(jsonText));
    } catch {
      /* non-JSON body; no usage */
    }
  }

  if (usage) {
    const cost = computeCost(usage.model, usage.usage);
    record(session, {
      provider,
      model: usage.model || reqModel,
      blocked: false,
      secrets,
      usage: usage.usage,
      costUsd: cost,
    });
    log.cost(
      `${usage.model}  in:${usage.usage.inputTokens} out:${usage.usage.outputTokens}  ` +
        `${usd(cost)}  · session ${usd(session.sessionTotal)}`,
    );
  } else {
    record(session, { provider, model: reqModel, blocked: false, secrets });
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function record(
  session: Session,
  p: {
    provider: ProviderId;
    model: string;
    blocked: boolean;
    blockReason?: string;
    secrets: DetectedSecret[];
    usage?: RequestRecord["usage"];
    costUsd?: number;
  },
) {
  const rec: RequestRecord = {
    id: randomUUID(),
    ts: Date.now(),
    provider: p.provider,
    model: p.model,
    usage: p.usage ?? { inputTokens: 0, outputTokens: 0 },
    costUsd: p.costUsd ?? 0,
    blocked: p.blocked,
    blockReason: p.blockReason,
    secrets: p.secrets,
  };
  session.addRecord(rec);
}

function handleControlPlane(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  session: Session,
  config: Config,
) {
  const u = new URL(url, "http://localhost");
  const path = u.pathname;

  if (path === "/__blackbox/status") {
    return json(res, 200, { status: session.status(), config });
  }
  if (path === "/__blackbox/recent") {
    return json(res, 200, { recent: session.recent(50), mcp: session.recentMcp(50) });
  }
  if (path === "/__blackbox/event" && req.method === "POST") {
    return readBody(req).then((buf) => {
      try {
        const ev = JSON.parse(buf.toString("utf8"));
        session.addMcpEvent(ev);
        if (ev.secrets?.length) {
          log.block(
            `MCP ${ev.action} ${ev.secrets.length} secret(s) via ${ev.server} ` +
              `${ev.direction}: ${ev.secrets.map((s: any) => s.type).join(", ")}`,
          );
        }
      } catch {
        /* ignore malformed events */
      }
      json(res, 200, { ok: true });
    });
  }
  if (path === "/__blackbox/allow") {
    const more = Number(u.searchParams.get("more") ?? "0");
    session.grantExtra(more);
    log.ok(`granted ${usd(more)} additional budget`);
    return json(res, 200, { granted: more });
  }
  if (path === "/__blackbox/dash" || path === "/__blackbox" || path === "/__blackbox/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(renderDashboard());
  }
  return json(res, 404, { error: "unknown control route" });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
