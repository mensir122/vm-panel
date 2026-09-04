#!/usr/bin/env bash
# start_manager.sh — spawn manager daemon di background + tunggu /health ok.
# Desain: docs/DESIGN.md §24. PID file oleh manager sendiri (runtime/pid).
set -euo pipefail

echo "[start_manager] start manager daemon"
mkdir -p logs/manager runtime/pid

nohup node manager/index.js >> logs/manager/manager-stdout.log 2>&1 &
echo $! > runtime/pid/manager-launcher.pid

# Health gate: /health harus 200 dalam 60 detik.
PORT="${MANAGER_API_PORT:-8097}"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/health"; then
    echo "[start_manager] manager ok di port ${PORT}"
    exit 0
  fi
  sleep 1
done

echo "[start_manager] GAGAL: manager tidak merespons dalam 60s"
tail -n 50 logs/manager/manager-stdout.log || true
exit 1
