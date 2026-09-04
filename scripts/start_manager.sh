#!/usr/bin/env bash
# start_manager.sh — spawn manager daemon di background + tunggu /health ok.
# Desain: docs/DESIGN.md §24. PID file oleh manager sendiri (runtime/pid).
set -euo pipefail

echo "[start_manager] start manager daemon"
mkdir -p logs/manager runtime/pid

nohup node manager/index.js >> logs/manager/manager-stdout.log 2>&1 &
echo $! > runtime/pid/manager-launcher.pid

# Health gate: /health harus 200 dalam 120 detik (cold-start runner GHA lambat).
# /health WAJIB bearer token — token ditulis manager ke runtime/sockets/cli-token
# saat start (manager.cli_token_written). Baca file itu untuk probe.
PORT="${MANAGER_API_PORT:-8097}"
TOKEN_FILE="runtime/sockets/cli-token"
for i in $(seq 1 120); do
  if [ -f "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
    if curl -sf --max-time 3 -o /dev/null -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${PORT}/health"; then
      echo "[start_manager] manager ok di port ${PORT} (detik ke-$i)"
      exit 0
    fi
  fi
  sleep 1
done

echo "[start_manager] GAGAL: manager tidak merespons dalam 120s"
echo "[start_manager] --- tail logs/manager/manager-stdout.log ---"
tail -n 50 logs/manager/manager-stdout.log 2>/dev/null || true
echo "[start_manager] --- tail logs/manager/manager.log (JSON) ---"
tail -n 30 logs/manager/manager.log 2>/dev/null || true
exit 1
