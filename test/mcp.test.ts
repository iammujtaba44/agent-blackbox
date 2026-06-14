import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { LineFramer } from "../src/mcp/framing.js";

test("LineFramer splits newline-delimited JSON and passes non-JSON through", () => {
  const f = new LineFramer();
  const a = f.push('{"a":1}\n{"b":2}\n');
  assert.equal(a.length, 2);
  assert.deepEqual(a[0].json, { a: 1 });
  assert.deepEqual(a[1].json, { b: 2 });
  // Partial line is buffered until its newline arrives.
  assert.equal(f.push('{"c":').length, 0);
  const b = f.push('3}\n');
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].json, { c: 3 });
  // Non-JSON line passes through with json = null.
  const c = f.push("not json\n");
  assert.equal(c[0].json, null);
  assert.equal(c[0].raw, "not json\n");
});

test("mcp wrapper redacts a secret in a tool result before it reaches the agent", async () => {
  const wrap = spawn(
    "npx",
    ["tsx", "src/cli.ts", "mcp", "--name", "fake", "--", "node", "test/fixtures/fake-mcp-server.mjs"],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
  );

  let out = "";
  wrap.stdout.setEncoding("utf8");
  wrap.stdout.on("data", (d) => (out += d));

  // Give the wrapper + child a moment to boot, then send a tools/call request.
  await waitFor(() => true, 1500);
  wrap.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_config", arguments: {} } }) + "\n",
  );

  await waitFor(() => out.includes("\n"), 15000);
  wrap.kill();

  assert.match(out, /\[REDACTED:AWS Access Key\]/, `got: ${out}`);
  assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"), "raw secret must not pass through");
  // The response is still valid JSON-RPC (redaction kept it parseable).
  const line = out.split("\n").find((l) => l.trim());
  assert.doesNotThrow(() => JSON.parse(line!));
});

function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("timeout waiting for condition"));
      }
    }, 50);
  });
}
