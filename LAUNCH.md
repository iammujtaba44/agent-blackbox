# Launch kit — Agent Black Box

Copy-paste drafts for announcing. Keep them honest and specific — the pain is
real, so you don't need hype. Record the GIF first (`npm run demo`), it does
most of the persuading.

---

## Show HN

**Title:**
`Show HN: Agent Black Box – a local firewall that blocks secrets/runaway spend from AI agents`

**Body:**
> I kept reading about AI coding agents leaking secrets into prompts and racking up surprise bills (one person left Claude Code running overnight and it cost $6k). The existing tools mostly *observe* — a dashboard you ignore. I wanted something that *enforces*.
>
> Agent Black Box is a local proxy you point your agent at (Claude Code, Cursor, Codex). It:
> - **Blocks secrets** (API keys, tokens, .env values) before they leave your machine — refuse or redact.
> - **Kills runaway spend** with a per-session/day budget that halts the agent (and survives restarts, so you can't bypass it by bouncing the proxy).
> - Also wraps **MCP servers** to redact secrets leaking through tool results.
> - No cloud, no account, no system certificate — one env var.
>
> It's MIT, Node, ~one dependency. The secret-blocking works with no API key (blocked requests never forward), so you can try it in 30 seconds:
> `npx agent-blackbox start`
>
> Would love feedback on the detection rules (false positives are the thing that kills tools like this) and what other agents people want supported.

---

## Reddit — r/ClaudeAI, r/LocalLLaMA, r/ChatGPTCoding

**Title:**
`I built a local firewall for AI coding agents — blocks secrets + caps runaway spend [MIT, open source]`

**Body:**
> After seeing people get $1000+ surprise bills and accidentally paste API keys into prompts, I built **Agent Black Box** — a tiny local proxy your agent talks to instead of the model directly.
>
> What it does:
> - 🔒 **Blocks secrets** leaking into prompts (AWS/GitHub/OpenAI/Stripe keys, JWTs, .env values) — before they ever leave your machine
> - 💀 **Budget kill-switch** — halts the agent when a run exceeds your limit, so no more overnight horror stories
> - 🔌 Wraps **MCP servers** too, redacting secrets in tool results
> - 💰 Shows exactly where your tokens/$$ go
>
> No account, no cloud, no certificate to install — just `npx agent-blackbox start` and point your agent at `localhost:4000`.
>
> It's free and MIT-licensed. Repo: https://github.com/iammujtaba44/agent-blackbox. The secret-blocking demo needs no API key — would genuinely love feedback on detection accuracy.

---

## X / Twitter thread

**1/**
Your AI coding agent will happily paste your `.env` into a prompt, or burn $500 in an overnight loop.

So I built a firewall for it. Local, open source, one command. 🧵

[attach the GIF]

**2/**
Agent Black Box sits between your agent (Claude Code, Cursor, Codex) and the model.

🔒 Blocks secrets before they leave your machine
💀 Kills runaway spend with a budget that survives restarts
🔌 Redacts secrets leaking through MCP tools

**3/**
No cloud. No account. No certificate to install. It uses a single env var, so it only sees your agent's traffic — nothing else.

The secret-blocking works with no API key, so you can try it in 30 seconds.

**4/**
`npx agent-blackbox start`

MIT licensed, ~one dependency. Repo + docs: https://github.com/iammujtaba44/agent-blackbox

Feedback on the detection rules very welcome — false positives are what kill tools like this, so I tuned hard against them.

---

## One-liner (for bios / directories)

> A local firewall for AI coding agents — blocks secret leaks and runaway token spend. Open source.
