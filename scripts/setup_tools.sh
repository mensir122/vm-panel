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
export INITIAL_PASSWORD="${INITIAL_PASSWORD:-29012009}"
if ! pgrep -f 'next-server' >/dev/null 2>&1 && ! pgrep -f '9router' >/dev/null 2>&1; then
  echo "[setup_tools] menyalakan 9router di background dengan INITIAL_PASSWORD..."
  nohup env INITIAL_PASSWORD="${INITIAL_PASSWORD}" 9router -p 8080 -n -t > /home/runner/9router.log 2>&1 &
  sleep 2
fi

# 4. Nyalakan Cloudflare Tunnel otomatis di background jika belum berjalan
if ! pgrep -f 'cloudflared tunnel' >/dev/null 2>&1; then
  echo "[setup_tools] menyalakan Cloudflare Tunnel publik..."
  if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    nohup cloudflared tunnel run --token "${CLOUDFLARE_TUNNEL_TOKEN}" > /home/runner/cloudflared.log 2>&1 &
  else
    nohup cloudflared tunnel --url http://localhost:8080 > /home/runner/cloudflared.log 2>&1 &
  fi
fi

# Polling URL publik dari cloudflared.log (maksimal 30 detik)
PUBLIC_URL=""
for i in {1..30}; do
  if [ -f /home/runner/cloudflared.log ]; then
    PUBLIC_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /home/runner/cloudflared.log | head -1 || true)
    if [ -n "$PUBLIC_URL" ]; then
      break
    fi
  fi
  sleep 1
done

if [ -n "$PUBLIC_URL" ]; then
  echo "$PUBLIC_URL" > /home/runner/PUBLIC_URL.txt
  echo "[setup_tools] 9Router URL publik aktif: $PUBLIC_URL"

  # Kirim ke GitHub Step Summary jika berjalan di Actions
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "### 🚀 9Router Online 24/7" >> "${GITHUB_STEP_SUMMARY}"
    echo "**URL Akses:** [${PUBLIC_URL}](${PUBLIC_URL})" >> "${GITHUB_STEP_SUMMARY}"
  fi

  # Notifikasi Telegram jika token tersedia
  TG_BOT="${TELEGRAM_BOT_TOKEN:-}"
  TG_CHAT="${TELEGRAM_CHAT_ID:-}"
  if [ -n "$TG_BOT" ] && [ -n "$TG_CHAT" ]; then
    echo "[setup_tools] mengirim notifikasi URL 9router ke Telegram..."
    curl -sf -X POST "https://api.telegram.org/bot${TG_BOT}/sendMessage" \
      -d chat_id="${TG_CHAT}" \
      -d text="🚀 <b>[9Router VPS 24/7 Aktif]</b>%0A🌐 URL Akses: ${PUBLIC_URL}%0A⚡ Server tetap menyala 24/7 walau laptop Anda mati." \
      -d parse_mode="HTML" >/dev/null 2>&1 || true
  fi

  # Simpan ke branch state agar dapat diakses kapan saja lewat URL raw GitHub
  REPO="${GITHUB_REPOSITORY:-}"
  TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -n "$TOKEN" ] && [ -n "$REPO" ]; then
    echo "[setup_tools] mencatat PUBLIC_URL.txt ke branch state..."
    B64=$(echo -n "$PUBLIC_URL" | base64 -w0)
    OLD_SHA=$(gh api "repos/${REPO}/contents/PUBLIC_URL.txt?ref=state" --jq '.sha // empty' 2>/dev/null || true)
    BODY=$(node --input-type=module -e "
      console.log(JSON.stringify({
        message: 'vps: update 9router public url',
        branch: 'state',
        content: '${B64}',
        sha: '${OLD_SHA}' || undefined,
      }));
    ")
    gh api -X PUT "repos/${REPO}/contents/PUBLIC_URL.txt" --input - <<< "${BODY}" >/dev/null 2>&1 || true
  fi
else
  echo "[setup_tools] Info: URL publik cloudflared belum terdeteksi atau menggunakan named tunnel token."
fi

echo "[setup_tools] perkakas dan layanan publik 24/7 siap digunakan!"
exit 0
