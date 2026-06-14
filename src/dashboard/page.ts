// Minimal zero-dependency dashboard. Polls the control-plane JSON endpoints.
export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Black Box</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:#0b0d10; color:#e6e9ef; }
  header { padding:18px 24px; border-bottom:1px solid #1c2129; display:flex; align-items:center; gap:12px; }
  header h1 { font-size:16px; margin:0; letter-spacing:.5px; }
  .badge { background:#11151b; border:1px solid #1c2129; border-radius:6px; padding:2px 8px; font-size:12px; color:#8b93a1; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; padding:24px; }
  .card { background:#11151b; border:1px solid #1c2129; border-radius:10px; padding:16px; }
  .card .label { color:#8b93a1; font-size:12px; text-transform:uppercase; letter-spacing:.5px; }
  .card .value { font-size:26px; margin-top:6px; font-weight:600; }
  .value.cost { color:#5ad1c5; } .value.block { color:#ff6b6b; } .value.warn { color:#ffd166; }
  table { width:100%; border-collapse:collapse; }
  h2 { padding:0 24px; font-size:13px; color:#8b93a1; text-transform:uppercase; letter-spacing:.5px; }
  td,th { text-align:left; padding:8px 24px; border-bottom:1px solid #161b22; font-size:13px; }
  th { color:#8b93a1; font-weight:500; }
  .pill { padding:1px 7px; border-radius:20px; font-size:11px; }
  .pill.blocked { background:#3a1416; color:#ff8585; } .pill.ok { background:#10261f; color:#5ad1c5; }
  .secret { color:#ff8585; }
</style>
</head>
<body>
<header>
  <h1>🛡️ AGENT BLACK BOX</h1>
  <span class="badge" id="uptime">—</span>
  <span class="badge" id="provider">firewall active</span>
</header>
<div class="grid">
  <div class="card"><div class="label">Session spend</div><div class="value cost" id="sessionTotal">$0.00</div></div>
  <div class="card"><div class="label">Today</div><div class="value cost" id="dailyTotal">$0.00</div></div>
  <div class="card"><div class="label">Requests</div><div class="value" id="requests">0</div></div>
  <div class="card"><div class="label">Secrets blocked</div><div class="value block" id="secretsBlocked">0</div></div>
  <div class="card"><div class="label">MCP secrets caught</div><div class="value block" id="mcpSecrets">0</div></div>
  <div class="card"><div class="label">Total blocked</div><div class="value warn" id="blocked">0</div></div>
</div>
<h2>Recent requests</h2>
<table>
  <thead><tr><th>Time</th><th>Model</th><th>In / Out</th><th>Cost</th><th>Status</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
const fmt = n => '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
async function tick() {
  try {
    const [s, r] = await Promise.all([
      fetch('/__blackbox/status').then(x=>x.json()),
      fetch('/__blackbox/recent').then(x=>x.json()),
    ]);
    const st = s.status;
    document.getElementById('sessionTotal').textContent = fmt(st.sessionTotal);
    document.getElementById('dailyTotal').textContent = fmt(st.dailyTotal);
    document.getElementById('requests').textContent = st.requests;
    document.getElementById('secretsBlocked').textContent = st.secretsBlocked;
    document.getElementById('mcpSecrets').textContent = st.mcpSecrets || 0;
    document.getElementById('blocked').textContent = st.blocked;
    document.getElementById('uptime').textContent = 'up ' + st.uptimeSec + 's';
    document.getElementById('rows').innerHTML = r.recent.map(rec => {
      const t = new Date(rec.ts).toLocaleTimeString();
      const io = rec.usage.inputTokens + ' / ' + rec.usage.outputTokens;
      const status = rec.blocked
        ? '<span class="pill blocked">BLOCKED: ' + (rec.blockReason||'') + '</span>'
        : '<span class="pill ok">ok</span>';
      const sec = rec.secrets && rec.secrets.length
        ? '<div class="secret">⚠ ' + rec.secrets.map(x=>x.type).join(', ') + '</div>' : '';
      return '<tr><td>'+t+'</td><td>'+rec.model+sec+'</td><td>'+io+'</td><td>'+fmt(rec.costUsd)+'</td><td>'+status+'</td></tr>';
    }).join('');
  } catch (e) {}
}
tick(); setInterval(tick, 1500);
</script>
</body>
</html>`;
}
