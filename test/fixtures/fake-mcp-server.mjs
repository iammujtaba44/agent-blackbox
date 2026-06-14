// A minimal fake MCP server: for any JSON-RPC request, it replies with a tool
// result whose text contains an AWS key — simulating a tool (e.g. a file reader)
// leaking a secret back toward the agent's context.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resp = {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      result: { content: [{ type: "text", text: "loaded config: AKIAIOSFODNN7EXAMPLE done" }] },
    };
    process.stdout.write(JSON.stringify(resp) + "\n");
  }
});
