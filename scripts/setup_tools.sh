#!/usr/bin/env bash
# scripts/setup_tools.sh — Otomasi pemasangan perkakas & aplikasi pengguna di setiap siklus 6 jam.
# Anda bisa menambahkan perintah instalasi aplikasi baru Anda di file ini!
set -euo pipefail

echo "[setup_tools] memeriksa dan memasang perkakas pengguna..."

# 1. 9router (Otomatis terpasang di setiap siklus)
if ! command -v 9router >/dev/null 2>&1; then
  echo "[setup_tools] menginstal 9router..."
  npm install -g 9router >/dev/null 2>&1 || true
fi

# Ubah port default 20128 -> 8080 di 9router secara permanen
if [ -d "/usr/local/lib/node_modules/9router" ]; then
  sudo sed -i 's/20128/8080/g' $(grep -rl "20128" /usr/local/lib/node_modules/9router/ 2>/dev/null) 2>/dev/null || true
fi

# ==============================================================================
# TAMBAHKAN APLIKASI ANDA DI BAWAH INI JIKA INGIN TERPASANG OTOMATIS:
# Contoh:
# npm install -g pm2
# sudo apt-get install -y python3-pip
# ==============================================================================

echo "[setup_tools] seluruh perkakas pengguna siap digunakan!"
exit 0
