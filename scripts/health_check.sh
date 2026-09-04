#!/usr/bin/env bash
# health_check.sh — health gate pasca-start (manager + panel wajib 200).
# Desain: docs/DESIGN.md §15.2 "health gate" — migration sukses HANYA jika ini lulus.
set -euo pipefail

MP="${MANAGER_API_PORT:-8097}"
PP="${PANEL_PORT:-8080}"
FAIL=0

if curl -sf -o /dev/null "http://127.0.0.1:${MP}/health"; then
  STATUS=$(curl -sf "http://127.0.0.1:${MP}/system/status" || echo '{}')
  echo "[health_check] manager: OK ${STATUS}"
else
  echo "[health_check] MANAGER DOWN"
  FAIL=1
fi

if curl -sf -o /dev/null "http://127.0.0.1:${PP}/login"; then
  echo "[health_check] panel: OK"
else
  echo "[health_check] PANEL DOWN"
  FAIL=1
fi

exit "$FAIL"
