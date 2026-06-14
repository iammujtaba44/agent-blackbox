import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config.js";
import { openStore } from "../src/store/db.js";

test("proxy injects stream_options.include_usage for OpenAI streams", async () => {
  let capturedBody = "";
  const mock = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      capturedBody = b;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: "gpt-4o", choices: [{ delta: { content: "hi" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ model: "gpt-4o", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => mock.listen(0, r));
  const mockPort = (mock.address() as import("node:net").AddressInfo).port;
  process.env.BLACKBOX_UPSTREAM_OPENAI = `http://localhost:${mockPort}`;

  const { createServer } = await import("../src/server.js");
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.secrets.scanEnvFiles = false;
  const { server, session } = createServer(cfg);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as import("node:net").AddressInfo).port;

  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  await res.text();

  const sent = JSON.parse(capturedBody);
  assert.equal(sent.stream_options?.include_usage, true, "should auto-inject include_usage");
  // gpt-4o: 100/1e6*2.5 + 20/1e6*10 = 0.00025 + 0.0002 = 0.00045
  assert.ok(Math.abs(session.sessionTotal - 0.00045) < 1e-7, `cost was ${session.sessionTotal}`);

  delete process.env.BLACKBOX_UPSTREAM_OPENAI;
  server.close();
  mock.close();
});

test("SQLite store persists daily spend across restarts", async () => {
  const path = join(tmpdir(), `bb-test-${process.pid}-${Date.now()}.db`);
  try {
    const store = await openStore(path);
    assert.ok(store, "node:sqlite should be available on Node 22+");
    const today = new Date().toISOString().slice(0, 10);

    store!.insertRequest({
      id: "r1", ts: Date.now(), provider: "anthropic", model: "claude-opus-4",
      usage: { inputTokens: 1000, outputTokens: 500 }, costUsd: 0.05, blocked: false, secrets: [],
    });
    assert.ok(Math.abs(store!.dailyTotal(today) - 0.05) < 1e-9);

    // "Restart": open a fresh store against the same file.
    const store2 = await openStore(path);
    assert.ok(Math.abs(store2!.dailyTotal(today) - 0.05) < 1e-9, "daily spend must survive restart");
    assert.equal(store2!.recentRequests(10).length, 1);
  } finally {
    rmSync(path, { force: true });
  }
});

test("blocked requests are not counted toward daily spend", async () => {
  const path = join(tmpdir(), `bb-test-blk-${process.pid}-${Date.now()}.db`);
  try {
    const store = await openStore(path);
    const today = new Date().toISOString().slice(0, 10);
    store!.insertRequest({
      id: "b1", ts: Date.now(), provider: "anthropic", model: "x",
      usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, blocked: true, blockReason: "secret", secrets: [],
    });
    assert.equal(store!.dailyTotal(today), 0);
  } finally {
    rmSync(path, { force: true });
  }
});
