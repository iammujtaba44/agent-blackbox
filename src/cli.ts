#!/usr/bin/env node
import kleur from "kleur";
import { basename, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { runDoctor } from "./doctor.js";
import { runMcpWrap } from "./mcp/wrap.js";
import { openStore } from "./store/db.js";
import { log } from "./log.js";

const HELP = `
${kleur.bold("🛡️  Agent Black Box")} — a firewall for your AI coding agent.

${kleur.bold("Usage")}
  blackbox start [--port <n>]     Start the proxy
  blackbox doctor [--ping]        Check your setup (proxy, base URL, key, live ping)
  blackbox mcp [--name x] -- CMD  Wrap an MCP server and scan its tool traffic
  blackbox allow --more <usd>     Grant extra budget to a running proxy
  blackbox --help

${kleur.bold("Point your agent at it")}
  Claude Code:   export ANTHROPIC_BASE_URL=http://localhost:4000
  Cursor/Codex:  export OPENAI_BASE_URL=http://localhost:4000/v1

Config (optional): create ${kleur.cyan(".blackbox.json")} in your project.
`;

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    }
  }
  return flags;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return;
  }

  const config = loadConfig();
  if (flags.port) config.port = Number(flags.port);

  if (cmd === "mcp") {
    const dd = process.argv.indexOf("--");
    if (dd === -1 || dd === process.argv.length - 1) {
      log.warn("usage: blackbox mcp [--name <label>] -- <command> [args...]");
      log.dim('example: blackbox mcp -- npx -y @modelcontextprotocol/server-filesystem /tmp');
      process.exit(1);
    }
    // Parse our own flags only from the portion before `--`.
    const ourFlags = parseFlags(process.argv.slice(3, dd));
    if (ourFlags.port) config.port = Number(ourFlags.port);
    const wrapped = process.argv.slice(dd + 1);
    const name = (ourFlags.name as string) || basename(wrapped[0]);
    runMcpWrap(config, name, wrapped[0], wrapped.slice(1));
    return; // the wrapper owns stdio from here
  }

  if (cmd === "doctor") {
    const code = await runDoctor(config, { ping: Boolean(flags.ping) });
    process.exit(code);
  }

  if (cmd === "allow") {
    const more = Number(flags.more ?? 0);
    if (!more) {
      log.warn("usage: blackbox allow --more <usd>");
      process.exit(1);
    }
    const res = await fetch(`http://localhost:${config.port}/__blackbox/allow?more=${more}`, { method: "POST" });
    if (res.ok) log.ok(`granted $${more.toFixed(2)} extra budget`);
    else log.warn("could not reach a running proxy on port " + config.port);
    return;
  }

  if (cmd !== "start") {
    log.warn(`unknown command: ${cmd}`);
    console.log(HELP);
    process.exit(1);
  }

  const store = flags["no-persist"]
    ? null
    : await openStore(resolve(process.cwd(), ".blackbox/history.db"));
  const { server } = createServer(config, store ?? undefined);
  server.listen(config.port, () => {
    const base = `http://localhost:${config.port}`;
    console.log("");
    log.ok(`firewall running at ${kleur.cyan(base)}`);
    log.info(`dashboard: ${kleur.cyan(base + "/__blackbox/dash")}`);
    console.log("");
    log.info(kleur.bold("Point your agent here:"));
    log.dim(`  Claude Code:  export ANTHROPIC_BASE_URL=${base}`);
    log.dim(`  Cursor/Codex: export OPENAI_BASE_URL=${base}/v1`);
    console.log("");
    log.info(
      `secrets: ${kleur.bold(config.secrets.action)}  ·  ` +
        `budget: ${kleur.bold("$" + config.budget.perSession)}/session ${kleur.bold("$" + config.budget.perDay)}/day  ·  ` +
        `providers: ${config.providers.join(", ")}  ·  ` +
        `history: ${store ? kleur.bold(".blackbox/history.db") : kleur.dim("in-memory")}`,
    );
    console.log("");
  });

  process.on("SIGINT", () => {
    console.log("");
    log.info("shutting down");
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  log.warn(err.message);
  process.exit(1);
});
