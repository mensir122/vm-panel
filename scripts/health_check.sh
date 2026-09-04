#!/usr/bin/env bash
# health_check.sh — health gate pasca-start (manager + panel wajib 200).
# Desain: docs/DESIGN.md §15.2 "health gate" — migration sukses HANYA jika ini lulus.
set -euo pipefail

MP="${MANAGER_API_PORT:-8097}"
PP="${PANEL_PORT:-8080}"
FAIL=0
TOKEN_FILE="runtime/sockets/cli-token"
AUTH=()
if [ -f "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
  TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
  AUTH=(-H "Authorization: Bearer ${TOKEN}")
fi

if [ "${#AUTH[@]}" -gt 0 ] && curl -sf --max-time 3 -o /dev/null "${AUTH[@]}" "http://127.0.0.1:${MP}/health"; then
  STATUS=$(curl -sf --max-time 3 "${AUTH[@]}" "http://127.0.0.1:${MP}/system/status" || echo '{}')
  echo "[health_check] manager: OK ${STATUS}"
else
  echo "[health_check] MANAGER DOWN (atau token belum tersedia)"
  FAIL=1
fi

if curl -sf -o /dev/null "http://127.0.0.1:${PP}/login"; then
  echo "[health_check] panel: OK"
else
  echo "[health_check] PANEL DOWN"
  FAIL=1
fi

exit "$FAIL"
