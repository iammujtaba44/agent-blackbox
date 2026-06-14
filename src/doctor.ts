import kleur from "kleur";
import type { Config } from "./types.js";
import { usd } from "./log.js";

type Status = "ok" | "warn" | "fail";

interface CheckResult {
  status: Status;
  title: string;
  detail?: string;
  fix?: string;
}

const icon = (s: Status) =>
  s === "ok" ? kleur.green("✔") : s === "warn" ? kleur.yellow("●") : kleur.red("✖");

function normalize(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

async function checkProxy(port: number): Promise<{ result: CheckResult; running: boolean; total?: number }> {
  try {
    const res = await fetch(`http://localhost:${port}/__blackbox/status`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as any;
    const st = body.status;
    return {
      running: true,
      total: st.sessionTotal,
      result: {
        status: "ok",
        title: `Proxy is running on port ${port}`,
        detail: `up ${st.uptimeSec}s · ${st.requests} requests · ${usd(st.sessionTotal)} spent · ${st.secretsBlocked} secrets blocked`,
      },
    };
  } catch {
    return {
      running: false,
      result: {
        status: "fail",
        title: `No proxy running on port ${port}`,
        fix: "Start it in another terminal:  blackbox start",
      },
    };
  }
}

function checkBaseUrl(name: string, expected: string): CheckResult {
  const val = process.env[name];
  if (!val) {
    return {
      status: "warn",
      title: `${name} is not set`,
      fix: `export ${name}=${expected}`,
    };
  }
  if (normalize(val) !== normalize(expected)) {
    return {
      status: "warn",
      title: `${name} points elsewhere`,
      detail: `currently: ${val}`,
      fix: `export ${name}=${expected}`,
    };
  }
  return { status: "ok", title: `${name} → ${val}` };
}

function checkApiKey(name: string, label: string): CheckResult {
  const val = process.env[name];
  if (!val) {
    return {
      status: "warn",
      title: `${name} is not set`,
      detail: `${label} forwarding needs your real key (the proxy passes it through).`,
      fix: `export ${name}=...`,
    };
  }
  const masked = val.slice(0, 7) + "…" + val.slice(-4);
  return { status: "ok", title: `${name} present (${masked})` };
}

async function livePing(port: number): Promise<CheckResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { status: "warn", title: "Skipped live ping (no ANTHROPIC_API_KEY)" };
  }
  try {
    const res = await fetch(`http://localhost:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      await res.text();
      return {
        status: "ok",
        title: "Live ping through proxy → Anthropic succeeded",
        detail: "End-to-end forwarding + cost accounting confirmed. Check the dashboard for the recorded cost.",
      };
    }
    const txt = await res.text();
    return {
      status: "fail",
      title: `Live ping failed (HTTP ${res.status})`,
      detail: txt.slice(0, 200),
      fix: res.status === 401 ? "Check your ANTHROPIC_API_KEY is valid." : undefined,
    };
  } catch (err) {
    return { status: "fail", title: `Live ping error: ${(err as Error).message}` };
  }
}

export async function runDoctor(config: Config, opts: { ping: boolean }): Promise<number> {
  const base = `http://localhost:${config.port}`;
  const checks: CheckResult[] = [];

  const proxy = await checkProxy(config.port);
  checks.push(proxy.result);

  if (config.providers.includes("anthropic")) {
    checks.push(checkBaseUrl("ANTHROPIC_BASE_URL", base));
    checks.push(checkApiKey("ANTHROPIC_API_KEY", "Anthropic"));
  }
  if (config.providers.includes("openai")) {
    checks.push(checkBaseUrl("OPENAI_BASE_URL", `${base}/v1`));
    checks.push(checkApiKey("OPENAI_API_KEY", "OpenAI"));
  }

  if (opts.ping) {
    if (proxy.running) checks.push(await livePing(config.port));
    else checks.push({ status: "warn", title: "Skipped live ping (proxy not running)" });
  }

  console.log("");
  console.log(kleur.bold("🩺 Agent Black Box — doctor"));
  console.log("");
  for (const c of checks) {
    console.log(`  ${icon(c.status)} ${c.title}`);
    if (c.detail) console.log(`     ${kleur.dim(c.detail)}`);
    if (c.fix) console.log(`     ${kleur.cyan("→ " + c.fix)}`);
  }
  console.log("");

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (fails) {
    const tail = warns ? kleur.yellow(` · ${warns} warning(s)`) : "";
    console.log(`  ${kleur.red(`${fails} issue(s) to fix`)}${tail}`);
  } else if (warns) {
    console.log(`  ${kleur.yellow(`${warns} warning(s)`)} — proxy works, but setup is incomplete.`);
  } else {
    console.log(`  ${kleur.green("All good. Your agent is wired through the firewall. 🛡️")}`);
  }
  console.log("");

  if (!opts.ping) {
    console.log(kleur.dim("  Tip: run `blackbox doctor --ping` to test a real request through to Anthropic."));
    console.log("");
  }

  return fails ? 1 : 0;
}
