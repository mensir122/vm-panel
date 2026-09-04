#!/usr/bin/env bash
# recovery_check.sh — cek status recovery manager (untuk operasi manual / debug).
set -euo pipefail

PORT="${MANAGER_API_PORT:-8097}"
if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/health"; then
  echo "[recovery_check] manager hidup"
  curl -sf "http://127.0.0.1:${PORT}/recovery/status" || echo "{}"
else
  echo "[recovery_check] manager DOWN — cek logs/manager/ dan runtime/pid/"
  exit 1
fi
