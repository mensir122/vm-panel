#!/usr/bin/env bash
# health_check.sh — health gate pasca-start (manager wajib 200).
# Desain: docs/DESIGN.md §15.2 "health gate" — migration sukses HANYA jika ini lulus.
set -euo pipefail

MP="${MANAGER_API_PORT:-8097}"
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

# Cek OpenSSH daemon (di Linux/runner) jika port 22 terbuka atau sshd aktif
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ssh 2>/dev/null; then
  echo "[health_check] ssh: OK (systemd service active)"
elif nc -z 127.0.0.1 22 2>/dev/null || (command -v ss >/dev/null 2>&1 && ss -tulpn | grep -q ':22\b'); then
  echo "[health_check] ssh: OK (port 22 listening)"
else
  echo "[health_check] ssh: standby (local/pre-tunnel)"
fi

exit "$FAIL"

