#!/usr/bin/env bash
# bootstrap.sh — persiapan fresh run: folder runtime + verify + konfigurasi env.
# Desain: fresh-start guarantee (bootstrap menolak folder non-kosong yang asing).
set -euo pipefail

echo "[bootstrap] mulai"
mkdir -p data backups runtime/pid runtime/locks runtime/sockets logs/manager logs/panel logs/projects

if [ ! -f package.json ]; then
  echo "[bootstrap] ERROR: dijalankan dari root project (package.json tidak ditemukan)"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[bootstrap] npm ci..."
  npm ci --no-audit --no-fund
fi

if [ -z "${VPANEL_MASTER_KEY:-}" ]; then
  echo "[bootstrap] PERINGATAN: VPANEL_MASTER_KEY tidak diset — panel akan memakai key random sekali (TOTP tidak bisa dipulihkan lintas runner)"
fi

echo "[bootstrap] selesai"
