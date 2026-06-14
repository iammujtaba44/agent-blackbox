import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import type { Config } from "../types.js";
import type { McpEvent } from "../session.js";
import { createScanner, scanRequestBody } from "../enforce/secrets.js";
import { LineFramer } from "./framing.js";

/**
 * Wrap a stdio MCP server. The agent spawns THIS instead of the real server;
 * we transparently relay JSON-RPC in both directions, scanning each message
 * for secrets. Tool results that carry secrets are redacted before they reach
 * the agent's context (and, later, the model). The real server is unaware.
 */
export function runMcpWrap(config: Config, serverName: string, command: string, args: string[]): void {
  const scanner = createScanner(config.secrets);
  // Blocking a single JSON-RPC message would hang the protocol, so for MCP we
  // enforce by redaction (warn mode only logs).
  const action: "redact" | "warn" = config.secrets.action === "warn" ? "warn" : "redact";

  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });

  child.on("error", (err) => {
    process.stderr.write(`[blackbox mcp] failed to start "${command}": ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  relay(process.stdin, child.stdin!, "agent→server", scanner, action, serverName, config);
  relay(child.stdout!, process.stdout, "server→agent", scanner, action, serverName, config);
}

function relay(
  src: Readable,
  dst: Writable,
  direction: McpEvent["direction"],
  scanner: ReturnType<typeof createScanner>,
  action: "redact" | "warn",
  serverName: string,
  config: Config,
): void {
  const framer = new LineFramer();
  const decoder = new TextDecoder();

  src.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (const { raw, json } of framer.push(text)) {
      if (!json) {
        dst.write(raw);
        continue;
      }
      const secrets = scanRequestBody(scanner, json);
      if (secrets.length === 0) {
        dst.write(raw);
        continue;
      }
      dst.write(action === "redact" ? scanner.redact(raw) : raw);
      const ev: McpEvent = {
        ts: Date.now(),
        server: serverName,
        direction,
        method: typeof json.method === "string" ? json.method : undefined,
        action,
        secrets,
      };
      report(config, ev);
      process.stderr.write(
        `[blackbox mcp] ${action === "redact" ? "REDACTED" : "WARN"} ${secrets.length} secret(s) ` +
          `${direction}${ev.method ? ` (${ev.method})` : ""}: ${secrets.map((s) => s.type).join(", ")}\n`,
      );
    }
  });

  src.on("end", () => {
    if (dst !== process.stdout) dst.end();
  });
}

/** Best-effort: tell a running proxy about the finding so the dashboard shows it. */
function report(config: Config, ev: McpEvent): void {
  fetch(`http://localhost:${config.port}/__blackbox/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ev),
    signal: AbortSignal.timeout(800),
  }).catch(() => {
    /* proxy not running — wrapper still works standalone */
  });
}
