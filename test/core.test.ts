import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createScanner, scanRequestBody } from "../src/enforce/secrets.js";
import { Session } from "../src/session.js";
import { checkBudget } from "../src/enforce/budget.js";
import { StreamUsageAccumulator, computeCost } from "../src/providers.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const policy = { action: "block" as const, allow: [] as string[], scanEnvFiles: false };

test("scanner detects real credentials", () => {
  const s = createScanner(policy);
  // Test secrets are assembled at runtime so no literal credential pattern
  // lives in the source — which would otherwise trip GitHub push protection on
  // this very repo. (AWS's published example key is allowlisted, so it stays.)
  assert.equal(s.scan("here is AKIAIOSFODNN7EXAMPLE for aws", "x").length, 1);
  assert.equal(s.scan("token sk-ant-" + "api03-" + "x".repeat(28), "x")[0].type, "Anthropic API Key");
  assert.ok(s.scan("ghp_" + "x".repeat(36), "x").length >= 1);
});

test("scanner ignores benign prose (no false positives)", () => {
  const s = createScanner(policy);
  assert.equal(s.scan("Please refactor the login function and add tests.", "x").length, 0);
  assert.equal(s.scan("The quick brown fox jumps over the lazy dog 1234.", "x").length, 0);
});

test("allowlist suppresses matches", () => {
  const s = createScanner({ ...policy, allow: ["sk-ant-test-*"] });
  assert.equal(s.scan("key sk-ant-test-000000000000000000", "x").length, 0);
});

test("redaction replaces the secret value", () => {
  const s = createScanner(policy);
  const out = s.redact("my key is AKIAIOSFODNN7EXAMPLE ok");
  assert.ok(out.includes("[REDACTED:AWS Access Key]"));
  assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("scanRequestBody walks nested message content + reports path", () => {
  const s = createScanner(policy);
  const body = {
    model: "claude-opus-4",
    messages: [{ role: "user", content: "deploy with AKIAIOSFODNN7EXAMPLE" }],
  };
  const found = scanRequestBody(s, body);
  assert.equal(found.length, 1);
  assert.match(found[0].where, /messages\[0\]\.content/);
});

test("detects additional credential formats", () => {
  const s = createScanner(policy);
  assert.equal(s.scan("SG." + "x".repeat(22) + "." + "y".repeat(43), "x")[0]?.type, "SendGrid API Key");
  assert.equal(s.scan("token npm_" + "x".repeat(36), "x")[0]?.type, "npm Token");
  assert.equal(s.scan("GOCSPX-" + "x".repeat(22), "x")[0]?.type, "Google OAuth Client Secret");
});

test("detects hardcoded credential assignments", () => {
  const s = createScanner(policy);
  assert.equal(s.scan('api_key = "a1b2c3d4e5f6g7h8i9"', "x")[0]?.type, "Hardcoded Credential");
  assert.equal(s.scan('const PASSWORD = "Sup3rSecretValue99"', "x").length, 1);
});

test("false-positive corpus: benign code must NOT trigger", () => {
  const s = createScanner(policy);
  const benign = [
    'const password = "changeme"',
    'api_key = "your_api_key_here"',
    'token: "<YOUR_TOKEN>"',
    'secret = "${process.env.SECRET}"',
    'const id = "550e8400-e29b-41d4-a716-446655440000"', // a UUID
    "Refactor getSecretValue() to read from the vault.",
    "Authorization: Bearer ${accessToken}",
    'const sk = "skateboard shop inventory"',
    "git commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
    'password: ""',
  ];
  for (const line of benign) {
    assert.equal(s.scan(line, "x").length, 0, `false positive on: ${line}`);
  }
});

test("redaction keeps the key prefix, removes only the value", () => {
  const s = createScanner(policy);
  const out = s.redact('api_key = "a1b2c3d4e5f6g7h8i9"');
  assert.match(out, /api_key = "\[REDACTED:Hardcoded Credential\]"/);
  assert.ok(!out.includes("a1b2c3d4e5f6g7h8i9"));
});

test("budget kill-switch trips when session spend exceeds limit", () => {
  const sess = new Session();
  const budget = { perSession: 1.0, perDay: 0, action: "block" as const };
  assert.equal(checkBudget(sess, budget).level, "ok");
  sess.addRecord({ id: "1", ts: Date.now(), provider: "anthropic", model: "x", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 1.5, blocked: false, secrets: [] });
  assert.equal(checkBudget(sess, budget).level, "block");
});

test("budget warns at 80% then granting more budget clears the block", () => {
  const sess = new Session();
  const budget = { perSession: 1.0, perDay: 0, action: "block" as const };
  sess.addRecord({ id: "1", ts: Date.now(), provider: "anthropic", model: "x", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0.85, blocked: false, secrets: [] });
  assert.equal(checkBudget(sess, budget).level, "warn");
  sess.addRecord({ id: "2", ts: Date.now(), provider: "anthropic", model: "x", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0.5, blocked: false, secrets: [] });
  assert.equal(checkBudget(sess, budget).level, "block");
  sess.grantExtra(5);
  assert.equal(checkBudget(sess, budget).level, "ok");
});

test("Anthropic streaming usage is accumulated across events", () => {
  const acc = new StreamUsageAccumulator("anthropic");
  acc.feed({ type: "message_start", message: { model: "claude-opus-4", usage: { input_tokens: 1000, cache_read_input_tokens: 0 } } });
  acc.feed({ type: "message_delta", usage: { output_tokens: 500 } });
  const r = acc.result();
  assert.ok(r);
  assert.equal(r!.usage.inputTokens, 1000);
  assert.equal(r!.usage.outputTokens, 500);
  // opus pricing: 1000/1e6*15 + 500/1e6*75 = 0.015 + 0.0375 = 0.0525
  assert.ok(Math.abs(computeCost(r!.model, r!.usage) - 0.0525) < 1e-9);
});

test("end-to-end: proxy blocks a request carrying a secret (HTTP 403)", async () => {
  const { createServer } = await import("../src/server.js");
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.secrets.scanEnvFiles = false;
  const { server } = createServer(cfg);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as import("node:net").AddressInfo).port;

  const res = await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-opus-4", messages: [{ role: "user", content: "use AKIAIOSFODNN7EXAMPLE" }] }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 403);
  assert.equal(body.error.type, "blocked_by_blackbox");
  server.close();
});

test("end-to-end: clean request forwards to a mock upstream + accounts cost", async () => {
  // Stand up a fake Anthropic that returns a streaming usage response.
  const mock = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-4", usage: { input_tokens: 2000 } } })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 1000 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => mock.listen(0, r));
  const mockPort = (mock.address() as import("node:net").AddressInfo).port;
  process.env.BLACKBOX_UPSTREAM_ANTHROPIC = `http://localhost:${mockPort}`;

  const { createServer } = await import("../src/server.js");
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.secrets.scanEnvFiles = false;
  const { server, session } = createServer(cfg);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as import("node:net").AddressInfo).port;

  const res = await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-opus-4", messages: [{ role: "user", content: "hello" }] }),
  });
  await res.text(); // drain stream
  assert.equal(res.status, 200);
  // opus: 2000/1e6*15 + 1000/1e6*75 = 0.03 + 0.075 = 0.105
  assert.ok(Math.abs(session.sessionTotal - 0.105) < 1e-6, `cost was ${session.sessionTotal}`);

  delete process.env.BLACKBOX_UPSTREAM_ANTHROPIC;
  server.close();
  mock.close();
});
