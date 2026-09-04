#!/usr/bin/env bash
# start_panel.sh — spawn panel web di background + tunggu /login 200.
set -euo pipefail

echo "[start_panel] start panel"
mkdir -p logs/panel runtime/pid

nohup node panel/server/index.js >> logs/panel/panel-stdout.log 2>&1 &
echo $! > runtime/pid/panel-launcher.pid

PORT="${PANEL_PORT:-8080}"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/login"; then
    echo "[start_panel] panel ok di port ${PORT}"
    exit 0
  fi
  sleep 1
done

echo "[start_panel] GAGAL: panel tidak merespons dalam 60s"
echo "[start_panel] --- tail logs/panel/panel-stdout.log ---"
tail -n 50 logs/panel/panel-stdout.log 2>/dev/null || true
exit 1
