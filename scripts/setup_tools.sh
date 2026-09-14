#!/usr/bin/env bash
# scripts/setup_tools.sh — Otomasi pemasangan perkakas & aplikasi pengguna di setiap siklus 6 jam.
set -euo pipefail

echo "[setup_tools] memeriksa dan memasang perkakas pengguna..."

# 1. 9router
if ! command -v 9router >/dev/null 2>&1; then
  echo "[setup_tools] menginstal 9router..."
  npm install -g 9router >/dev/null 2>&1 || true
fi

# Ubah port default 20128 -> 8080 di 9router secara permanen
if [ -d "/usr/local/lib/node_modules/9router" ]; then
  FILES=$(grep -rl "20128" /usr/local/lib/node_modules/9router/ 2>/dev/null || true)
  if [ -n "$FILES" ]; then
    sudo sed -i 's/20128/8080/g' $FILES 2>/dev/null || true
  fi
fi

# 2. Cloudflared (untuk akses URL publik 24/7 di HP)
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[setup_tools] menginstal cloudflared..."
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb >/dev/null 2>&1 || true
  sudo dpkg -i /tmp/cloudflared.deb >/dev/null 2>&1 || true
fi

# 3. Nyalakan 9router otomatis di background jika belum berjalan
if ! pgrep -f 'next-server' >/dev/null 2>&1 && ! pgrep -f '9router' >/dev/null 2>&1; then
  echo "[setup_tools] menyalakan 9router di background..."
  nohup 9router -p 8080 -n -t > /home/runner/9router.log 2>&1 &
  sleep 2
fi

# 4. Nyalakan Cloudflare Tunnel otomatis di background jika belum berjalan
if ! pgrep -f 'cloudflared tunnel' >/dev/null 2>&1; then
  echo "[setup_tools] menyalakan Cloudflare Tunnel publik..."
  nohup cloudflared tunnel --url http://localhost:8080 > /home/runner/cloudflared.log 2>&1 &
  sleep 4
fi

# Simpan link publik ke file ~/PUBLIC_URL.txt agar mudah dibaca
sleep 3
grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /home/runner/cloudflared.log | head -1 > /home/runner/PUBLIC_URL.txt 2>/dev/null || true

echo "[setup_tools] perkakas dan layanan publik 24/7 siap digunakan!"
exit 0
