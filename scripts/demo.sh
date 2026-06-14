#!/usr/bin/env bash
# Self-contained demo for recording a GIF — no API key required.
# Spins up a mock model endpoint so cost accounting works offline, then shows
# the two headline features: secret blocking and the budget/cost tracker.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=4000
MOCK_PORT=4910
RED=$'\e[31m'; GRN=$'\e[32m'; CYN=$'\e[36m'; DIM=$'\e[2m'; BLD=$'\e[1m'; RST=$'\e[0m'

echo "${DIM}building…${RST}"; npm run build >/dev/null 2>&1

# Mock model: streams back a usage event so the proxy can price the request.
node -e '
const http=require("http");
http.createServer((req,res)=>{res.writeHead(200,{"content-type":"text/event-stream"});
res.write("data: "+JSON.stringify({type:"message_start",message:{model:"claude-opus-4",usage:{input_tokens:1820}}})+"\n\n");
res.write("data: "+JSON.stringify({type:"message_delta",usage:{output_tokens:640}})+"\n\n");
res.end("data: [DONE]\n\n");}).listen('"$MOCK_PORT"');
' &
MOCK=$!

BLACKBOX_UPSTREAM_ANTHROPIC="http://localhost:$MOCK_PORT" node dist/cli.js start --port "$PORT" >/tmp/bb_demo.log 2>&1 &
BB=$!
trap 'kill $BB $MOCK 2>/dev/null || true' EXIT
sleep 1.3

req() { curl -s -X POST "http://localhost:$PORT/v1/messages" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -d "$1"; }

echo
echo "${BLD}🛡️  Agent Black Box — a firewall for your AI coding agent${RST}"
echo "${DIM}   (your agent talks to localhost:$PORT instead of the model directly)${RST}"
sleep 1

echo
echo "${BLD}1) A normal request flows straight through — and gets priced:${RST}"
sleep 0.8
req '{"model":"claude-opus-4","messages":[{"role":"user","content":"refactor my auth module"}]}' >/dev/null
sleep 0.4
grep -E '^\s*\S+\s+\$' /tmp/bb_demo.log | tail -1 | sed "s/^/   ${CYN}/;s/$/${RST}/"
sleep 1.2

echo
echo "${BLD}2) But watch what happens when the agent leaks a secret:${RST}"
echo "${DIM}   sending a prompt containing an AWS key…${RST}"
sleep 1
echo "   ${RED}$(req '{"model":"claude-opus-4","messages":[{"role":"user","content":"deploy with AKIAIOSFODNN7EXAMPLE"}]}' | sed 's/.*"message":"//;s/"}}//;s/\\"/"/g')${RST}"
sleep 1.5

echo
echo "${GRN}   ✔ The secret never left your machine.${RST}"
echo "${DIM}   Live dashboard: http://localhost:$PORT/__blackbox/dash${RST}"
echo
echo "${BLD}Install:${RST} ${CYN}npx agent-blackbox start${RST}"
echo
sleep 1
