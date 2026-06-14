# 🛡️ Agent Black Box

[![npm](https://img.shields.io/npm/v/agent-blackbox?style=flat&logo=npm)](https://www.npmjs.com/package/agent-blackbox)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/iammujtaba44?style=flat&logo=github&label=Sponsor)](https://github.com/sponsors/iammujtaba44)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/immujtaba9h)

**A firewall for your AI coding agent.** It sits between your agent (Claude Code, Cursor, Codex…) and the model, and does two things you can't afford to skip:

- 🔒 **Blocks secrets** from leaking into prompts — API keys, tokens, private keys, `.env` values. The secret never leaves your machine.
- 💀 **Kills runaway spend** — a budget kill-switch halts the agent before a stuck loop turns into a $6,000 morning.

It also shows you exactly where your tokens (and dollars) go.

<p align="center"><img src="docs/demo.gif" alt="Blocking a leaked secret and tracking token cost" width="720"></p>

> No cloud. No account. No system certificate. One command, and your agent's traffic flows through a local proxy you control.

> ✅ **Works with any agent that uses an API key** — Claude Code, OpenAI Codex, Cursor (own-key mode), and custom agent frameworks / CI pipelines. See [Supported agents](#supported-agents).
>
> ℹ️ **Not for flat-rate subscription mode** (Claude Pro, Cursor Pro). That traffic routes through the vendor's own cloud and can't be intercepted by *any* local tool — and a flat plan can't run up a metered bill anyway. Agent Black Box is for **metered, API-key usage**, which is exactly where runaway spend and leaked secrets actually happen.

---

## Why

AI coding agents are powerful and *blind*. They'll happily paste the contents of your `.env` into a prompt, or burn through your entire month's budget overnight in a retry loop. People have reported **$6,000 overnight runs** and **$47k in three days**. Agent Black Box is the seatbelt.

Most tools in this space *observe* (a dashboard you can ignore). Agent Black Box **enforces** — it blocks the leak and stops the spend. That's the difference between a vitamin and a painkiller.

---

## Quick start

```bash
npx agent-blackbox start
```

Then point your agent at it:

```bash
# Claude Code
export ANTHROPIC_BASE_URL=http://localhost:4000

# Cursor / Codex / OpenAI-compatible
export OPENAI_BASE_URL=http://localhost:4000/v1
```

That's it. Your agent works exactly as before — except now secrets get blocked and spend gets capped. Open the live dashboard at **http://localhost:4000/__blackbox/dash**.

### Not sure it's wired up? Run the doctor

```bash
blackbox doctor          # checks proxy, base URL, API key
blackbox doctor --ping   # + sends a real request through to Anthropic to prove it works
```

```
🩺 Agent Black Box — doctor
  ✔ Proxy is running on port 4000
  ✔ ANTHROPIC_BASE_URL → http://localhost:4000
  ✔ ANTHROPIC_API_KEY present (sk-ant-…-x9f2)
  ✔ Live ping through proxy → Anthropic succeeded
  All good. Your agent is wired through the firewall. 🛡️
```

### See it work

```bash
# This request is blocked before it ever reaches the model:
curl -X POST http://localhost:4000/v1/messages \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-opus-4","messages":[{"role":"user","content":"deploy with AKIAIOSFODNN7EXAMPLE"}]}'

# → 403  "🛡️ blocked: it contained 1 secret(s) — AWS Access Key @ messages[0].content"
```

---

## Supported agents

Agent Black Box intercepts traffic that flows through it — which means **any agent you point at it with an API key**. Subscription/Pro modes route through the vendor's cloud and **cannot** be intercepted (by this or any local tool).

| Agent | How to connect | Works? |
|---|---|---|
| **Claude Code** (terminal CLI, API key) | `export ANTHROPIC_BASE_URL=http://localhost:4000` then run `claude` in that shell | ✅ |
| **OpenAI Codex** (CLI) | `export OPENAI_BASE_URL=http://localhost:4000/v1` + `OPENAI_API_KEY` then run `codex` | ✅ |
| **Cursor** (own-key mode) | Settings → Models → **Override OpenAI Base URL** = `http://localhost:4000/v1` + your OpenAI key | ✅ |
| **Custom frameworks / CI** (LangChain, scripts, agents) | set the SDK's base URL to the proxy | ✅ |
| **Claude Code / Cursor — subscription/Pro** | n/a — routes through the vendor cloud | ❌ not interceptable |

> The env var only affects programs launched **from that same shell**. A desktop app opened by clicking won't inherit it — configure those via the app's own settings (e.g. `.claude/settings.json` `env` block) and fully restart the app.

Run `blackbox doctor --ping` anytime to confirm your wiring.

---

## What it catches

**Secrets / PII:** AWS keys, GitHub tokens, OpenAI/Anthropic/Stripe/Google/Slack keys, JWTs, private keys, generic bearer secrets, high-entropy strings, and **values pulled from your project's `.env`** files. Tuned for low false positives — a firewall that cries wolf gets turned off.

**Spend:** per-session and per-day USD ceilings, with an 80% warning and a hard kill-switch. Streaming-aware token + cost accounting for every request.

---

## MCP tool inspection

Your agent doesn't only talk to the model — it calls **MCP tools** (file readers, GitHub, databases). Secrets leak through those too: a tool reads a config file and the secret flows into the agent's context. The main proxy can't see this (MCP runs over stdio, not HTTP), so wrap the MCP server instead:

```jsonc
// In your agent's MCP config, change this:
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }

// …to route it through the firewall:
{ "command": "npx", "args": ["agent-blackbox", "mcp", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"] }
```

Now every JSON-RPC message in both directions is scanned. Secrets in tool results get **redacted before they reach the agent** — and the finding shows up on your dashboard. The real MCP server is unaware it's wrapped.

```
$ echo '{"jsonrpc":"2.0","id":1,"method":"tools/call",...}' | agent-blackbox mcp -- node my-server.js
→ tool result rewritten: "loaded config: [REDACTED:AWS Access Key] done"
[blackbox mcp] REDACTED 1 secret(s) server→agent: AWS Access Key
```

## Configuration

Optional — it works with sensible defaults. Drop a `.blackbox.json` in your project:

```json
{
  "port": 4000,
  "secrets": {
    "action": "block",        // "block" | "redact" | "warn"
    "allow": ["sk-ant-test-*"],
    "scanEnvFiles": true
  },
  "budget": {
    "perSession": 5.00,
    "perDay": 50.00,
    "action": "block"         // "block" | "warn"
  },
  "providers": ["anthropic", "openai"]
}
```

- **`secrets.action`** — `block` refuses the request; `redact` strips the secret and forwards; `warn` only logs.
- **`budget.action`** — `block` halts the agent at the ceiling; `warn` only alerts.

Hit a ceiling mid-task and want to keep going?

```bash
blackbox allow --more 10     # grant $10 more to the running proxy
```

---

## How it works

```
  Your agent ──▶ Agent Black Box (localhost) ──▶ api.anthropic.com / api.openai.com
                      │
                      ├─ pre-flight: scan body for secrets → block / redact
                      ├─ pre-flight: budget kill-switch → halt if over limit
                      └─ post-flight: parse usage → tally tokens + cost
```

Enforcement happens **before** the request leaves your machine, so blocking actually prevents the leak and the spend. Responses stream through **untouched** — the agent never knows it's there.

It uses the simple base-URL method (one env var) — **no system certificate, no MITM of your other HTTPS traffic.** That's a deliberate trust decision.

---

## Roadmap

- [x] **v0.1** — local proxy, secret blocking, budget kill-switch, cost accounting, dashboard (Anthropic + OpenAI)
- [x] **v0.2** — MCP tool inspection (stdio wrapper, in-flight redaction); hardened scanner; `doctor`; OpenAI streaming cost (auto-injected usage); **SQLite history that survives restarts** (so the daily kill-switch can't be bypassed by restarting)
- [ ] **v0.3** — optional transparent mode (zero per-agent config); team dashboard + policy engine (paid)
- [ ] **v1.0** — team dashboard, org policy engine, audit logs (the paid layer)

---

## Development

```bash
npm install
npm run dev      # start the proxy with tsx
npm test         # run the test suite
npm run build    # compile to dist/
```

## Support

If Agent Black Box saves you from a leaked key or a runaway bill, consider sponsoring — it keeps the project moving:

[![GitHub Sponsors](https://img.shields.io/github/sponsors/iammujtaba44?style=flat&logo=github&label=Sponsor)](https://github.com/sponsors/iammujtaba44)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-☕-yellow)](https://buymeacoffee.com/immujtaba9h)

## License

MIT © [Muhammad Mujtaba](https://www.mujtaba.cc)
