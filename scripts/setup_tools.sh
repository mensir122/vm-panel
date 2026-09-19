#!/usr/bin/env bash
# scripts/setup_tools.sh — Otomasi pemasangan perkakas & aplikasi pengguna di setiap siklus 6 jam.
set -euo pipefail

echo "[setup_tools] memeriksa dan memasang perkakas pengguna..."

# 0. FFmpeg (Wajib untuk OriontClipper video & audio processing)
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[setup_tools] menginstal ffmpeg..."
  sudo apt-get update -qq >/dev/null 2>&1 || true
  sudo apt-get install -y -qq ffmpeg >/dev/null 2>&1 || true
fi

# 0b. Deno & yt-dlp challenge-solver (Wajib untuk bypass YouTube JS/n-challenge di VPS)
if ! command -v deno >/dev/null 2>&1 && [ ! -x "/home/runner/.deno/bin/deno" ]; then
  echo "[setup_tools] menginstal Deno runtime untuk yt-dlp..."
  curl -fsSL https://deno.land/install.sh | sh >/dev/null 2>&1 || true
fi
if [ -x "/home/runner/.deno/bin/deno" ]; then
  sudo ln -sf /home/runner/.deno/bin/deno /usr/local/bin/deno 2>/dev/null || true
fi

# 0c. Update yt-dlp & konfigurasi global challenge solver & JS runtimes
pip install -U yt-dlp >/dev/null 2>&1 || true
mkdir -p /home/runner/.config/yt-dlp
cat << 'EOF_YTDLP' > /home/runner/.config/yt-dlp/config
--remote-components ejs:github
--js-runtimes deno
--js-runtimes node
EOF_YTDLP

# Pre-cache challenge solver agar siap pakai secara instan
yt-dlp --remote-components ejs:github --js-runtimes deno --version >/dev/null 2>&1 || true
python3 -c "import yt_dlp; yt_dlp.YoutubeDL({'remote_components': ['ejs:github'], 'quiet': True}).extract_info('https://www.youtube.com/watch?v=_gfPQsRkacI', download=False)" >/dev/null 2>&1 || true

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

# 4. Nyalakan Ngrok Permanent Domain jika token & domain tersedia
NGROK_TOKEN="${NGROK_AUTHTOKEN:-3JOdSEElbSe5UwaMtFVynGXKDkK_z5MpEa3VRjXHqTkdZ3ZH}"
NGROK_DOM="${NGROK_DOMAIN:-chair-cyclist-premium.ngrok-free.dev}"

PUBLIC_URL=""

if [ -n "${NGROK_TOKEN}" ] && [ -n "${NGROK_DOM}" ]; then
  if ! pgrep -f 'ngrok http' >/dev/null 2>&1; then
    echo "[setup_tools] menyalakan Ngrok Permanent Domain (https://${NGROK_DOM})..."
    if ! command -v ngrok >/dev/null 2>&1; then
      curl -sSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | sudo tar -xz -C /usr/local/bin 2>/dev/null || true
    fi
    ngrok config add-authtoken "${NGROK_TOKEN}" >/dev/null 2>&1 || true
    nohup ngrok http --url "https://${NGROK_DOM}" 8080 > /home/runner/ngrok.log 2>&1 &
    sleep 2
  fi
  PUBLIC_URL="https://${NGROK_DOM}"
fi

# 5. Nyalakan Cloudflare Tunnel sebagai fallback / backup
if [ -z "${PUBLIC_URL}" ]; then
  if ! pgrep -f 'cloudflared tunnel' >/dev/null 2>&1; then
    echo "[setup_tools] menyalakan Cloudflare Tunnel publik..."
    if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
      nohup cloudflared tunnel run --token "${CLOUDFLARE_TUNNEL_TOKEN}" > /home/runner/cloudflared.log 2>&1 &
    else
      nohup cloudflared tunnel --url http://localhost:8080 > /home/runner/cloudflared.log 2>&1 &
    fi
  fi

  # Polling URL publik dari cloudflared.log (maksimal 30 detik)
  for i in {1..30}; do
    if [ -f /home/runner/cloudflared.log ]; then
      PUBLIC_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /home/runner/cloudflared.log | head -1 || true)
      if [ -n "$PUBLIC_URL" ]; then
        break
      fi
    fi
    sleep 1
  done
fi

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

# 6. Nyalakan OriontClipper bot otomatis jika ada
if [ -d "/home/runner/OriontClipper" ]; then
  echo "[setup_tools] mendeteksi direktori OriontClipper, menyalakan bot 24/7..."
  # Sinkronisasi / restore cookies permanen jika tmp/ kosong
  if [ -f "/home/runner/OriontClipper/data/cookies_shared.txt" ] && [ ! -f "/home/runner/OriontClipper/tmp/cookies_shared.txt" ]; then
    echo "[setup_tools] memulihkan cookies YouTube dari data/cookies_shared.txt..."
    mkdir -p /home/runner/OriontClipper/tmp
    cp /home/runner/OriontClipper/data/cookies_shared.txt /home/runner/OriontClipper/tmp/cookies_shared.txt
    chmod 600 /home/runner/OriontClipper/tmp/cookies_shared.txt 2>/dev/null || true
  elif [ -f "/home/runner/OriontClipper/tmp/cookies_shared.txt" ] && [ ! -f "/home/runner/OriontClipper/data/cookies_shared.txt" ]; then
    mkdir -p /home/runner/OriontClipper/data
    cp /home/runner/OriontClipper/tmp/cookies_shared.txt /home/runner/OriontClipper/data/cookies_shared.txt
    chmod 600 /home/runner/OriontClipper/data/cookies_shared.txt 2>/dev/null || true
  fi

  if [ -f "scripts/patch_oriontclipper.py" ]; then
    echo "[setup_tools] memastikan patch yt-dlp & Deno challenge solver terpasang..."
    python3 scripts/patch_oriontclipper.py /home/runner/OriontClipper || true
  fi
  if ! pgrep -f 'python.*bot\.py' >/dev/null 2>&1; then
    (
      export PATH="/home/runner/.deno/bin:${PATH}"
      cd /home/runner/OriontClipper
      if [ -f "start_bot.py" ]; then
        python3 start_bot.py >/dev/null 2>&1 || true
      elif [ -x ".venv/bin/python" ]; then
        nohup .venv/bin/python bot.py > bot.log 2>&1 &
      else
        nohup python3 bot.py > bot.log 2>&1 &
      fi
    )
    echo "[setup_tools] OriontClipper bot berhasil dinyalakan otomatis!"
  else
    echo "[setup_tools] OriontClipper bot sudah berjalan."
  fi
fi

echo "[setup_tools] perkakas dan layanan publik 24/7 siap digunakan!"
exit 0
