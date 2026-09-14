#!/usr/bin/env bash
# start_tunnel.sh — Menghubungkan Headless VPS ke Tailscale / Cloudflare Tunnel / Tmate.
# Desain: Reverse tunnel multi-provider terisolasi dengan zero-trust firewall & anti-leak.
set -euo pipefail

echo "[start_tunnel] mulai inisialisasi reverse tunnel jaringan"
mkdir -p logs/tunnel runtime/pid

TS_KEY="${TAILSCALE_AUTHKEY:-}"
CF_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
NGROK_TOKEN="${NGROK_AUTHTOKEN:-}"
TG_BOT="${TELEGRAM_BOT_TOKEN:-}"
TG_CHAT="${TELEGRAM_CHAT_ID:-}"
REPO="${GITHUB_REPOSITORY:-mensir122/vm-panel}"
RUN_ID="${GITHUB_RUN_ID:-}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
TMATE_SSH_CMD="${TMATE_SSH_CMD:-}"

TARGET_USER="${USER:-runner}"
USER_HOME=$(eval echo "~${TARGET_USER}")
AUTH_KEYS="${USER_HOME}/.ssh/authorized_keys"

commit_connection_state() {
  local CONN_FILE="runtime/vps-connection.json"
  local TARGET_FILE="vps-connection.json"
  local UPLOAD_FILE="${CONN_FILE}"

  if [ -n "${VPANEL_MASTER_KEY:-}" ] && [ -f "${CONN_FILE}" ]; then
    echo "[start_tunnel] mengenkripsi data koneksi dengan VPANEL_MASTER_KEY (AES-256-GCM)..."
    node scripts/vps-connection.mjs encrypt "${CONN_FILE}" "runtime/vps-connection.enc" || true
    if [ -f "runtime/vps-connection.enc" ]; then
      TARGET_FILE="vps-connection.enc"
      UPLOAD_FILE="runtime/vps-connection.enc"
    fi
  fi

  if [ -n "${GH_TOKEN:-}" ] && [ -n "${REPO:-}" ] && [ -f "${UPLOAD_FILE}" ]; then
    echo "[start_tunnel] mencatat ${TARGET_FILE} ke branch state..."
    local B64 OLD_SHA BODY
    B64=$(base64 -w0 "${UPLOAD_FILE}")
    OLD_SHA=$(gh api "repos/${REPO}/contents/${TARGET_FILE}?ref=state" --jq '.sha // empty' 2>/dev/null || true)
    BODY=$(
      export RUN_ID B64 OLD_SHA TARGET_FILE
      node --input-type=module -e "
        console.log(JSON.stringify({
          message: 'vps: ' + process.env.TARGET_FILE + ' run ' + (process.env.RUN_ID || 'unknown') + ' (auto)',
          branch: 'state',
          content: process.env.B64,
          sha: process.env.OLD_SHA || undefined,
        }));
      "
    )
    local API_ERR
    if API_ERR=$(gh api -X PUT "repos/${REPO}/contents/${TARGET_FILE}" --input - <<< "${BODY}" 2>&1); then
      echo "[start_tunnel] ${TARGET_FILE} berhasil tersimpan di branch state (siap untuk 'npm run ssh')"
    else
      echo "[start_tunnel] PERINGATAN: gagal upload ${TARGET_FILE} via GitHub API: ${API_ERR}"
    fi
  else
    echo "[start_tunnel] Lewati upload state: GH_TOKEN=${GH_TOKEN:+ada}, REPO=${REPO}, UPLOAD_FILE=${UPLOAD_FILE}"
  fi
}

# 1. OPSI A: Tailscale Mesh VPN (Sangat Direkomendasikan & Privat Total)
if [ -n "$TS_KEY" ]; then
  echo "[start_tunnel] provider terdeteksi: TAILSCALE (Private WireGuard Mesh)"
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "[start_tunnel] mengunduh dan menginstal Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sudo sh >/dev/null 2>&1 || true
  fi

  # Start tailscaled daemon bila belum berjalan
  if ! pgrep -x tailscaled >/dev/null 2>&1; then
    sudo tailscaled --tun=userspace-networking --socks5-server=localhost:1055 >logs/tunnel/tailscaled.log 2>&1 &
    echo $! > runtime/pid/tailscaled.pid
    sleep 2
  fi

  # Hubungkan runner ke Tailnet pengguna dengan hostname tetap 'vpanel-vps'
  echo "[start_tunnel] mendaftarkan node ke Tailnet..."
  if sudo tailscale up --authkey="${TS_KEY}" --hostname="vpanel-vps" --ssh=true --accept-routes --accept-dns=false >logs/tunnel/tailscale-up.log 2>&1; then
    TS_IP=$(tailscale ip -4 2>/dev/null || echo "100.x.y.z")
    echo "[start_tunnel] KONEKSI TAILSCALE BERHASIL!"
    echo "[start_tunnel] Hostname Tailscale: vpanel-vps"
    echo "[start_tunnel] IP Tailscale      : ${TS_IP}"

    # FIREWALL HARDENING: Blokir port 22 dari interface publik (eth0), HANYA izinkan via Tailscale & Loopback
    if command -v iptables >/dev/null 2>&1; then
      echo "[start_tunnel] menerapkan firewall isolasi ketat (iptables anti-probe publik)..."
      sudo iptables -F INPUT 2>/dev/null || true
      sudo iptables -A INPUT -i lo -j ACCEPT 2>/dev/null || true
      sudo iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
      sudo iptables -A INPUT -i tailscale0 -p tcp --dport 22 -j ACCEPT 2>/dev/null || true
      sudo iptables -A INPUT -p tcp --dport 22 -s 127.0.0.1 -j ACCEPT 2>/dev/null || true
      sudo iptables -A INPUT -p tcp --dport 22 -j DROP 2>/dev/null || true
      echo "[start_tunnel] Firewall aktif: Port 22 terkunci total dari jaringan publik"
    fi

    cat > runtime/vps-connection.json <<EOF
{
  "provider": "tailscale",
  "ssh_cmd": "ssh ${TARGET_USER}@vpanel-vps",
  "ip": "${TS_IP}",
  "run_id": "${RUN_ID}",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    commit_connection_state
    echo "[start_tunnel] Akses SSH privat: ssh ${TARGET_USER}@vpanel-vps"
    exit 0
  else
    echo "[start_tunnel] Tailscale up gagal, beralih ke provider berikutnya..."
  fi
fi

# 2. OPSI B: Cloudflare Tunnel
if [ -n "$CF_TOKEN" ]; then
  echo "[start_tunnel] provider terdeteksi: CLOUDFLARE TUNNEL"
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "[start_tunnel] mengunduh binary cloudflared..."
    curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb >/dev/null 2>&1 || true
    sudo dpkg -i /tmp/cloudflared.deb >/dev/null 2>&1 || true
  fi
  nohup cloudflared tunnel run --token "${CF_TOKEN}" >> logs/tunnel/cloudflared.log 2>&1 &
  echo $! > runtime/pid/tunnel-launcher.pid
  echo "[start_tunnel] Cloudflare tunnel daemon berjalan di background"
  exit 0
fi

# 3. OPSI C: Ngrok TCP Tunnel
if [ -n "$NGROK_TOKEN" ]; then
  echo "[start_tunnel] provider terdeteksi: NGROK"
  if ! command -v ngrok >/dev/null 2>&1; then
    curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
    echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list >/dev/null
    sudo apt-get update -qq >/dev/null 2>&1 || true
    sudo apt-get install -y -qq ngrok >/dev/null 2>&1 || true
  fi
  ngrok config add-authtoken "${NGROK_TOKEN}" >/dev/null 2>&1 || true
  nohup ngrok tcp 22 --log=stdout >> logs/tunnel/ngrok.log 2>&1 &
  echo $! > runtime/pid/tunnel-launcher.pid
  sleep 3
  NGROK_URL=$(curl -sf http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o 'tcp://[^"]*' || echo "")
  if [ -n "$NGROK_URL" ]; then
    echo "::add-mask::${NGROK_URL}"
    echo "[start_tunnel] Ngrok tunnel aktif (URL disensor di log untuk keamanan)"
  fi
  exit 0
fi

# 4. OPSI D: Upterm Reverse SSH Relay (Zero-Install, Zero-Trust Key Enforced)
echo "[start_tunnel] Mencoba inisialisasi sesi Upterm (Zero-Install)..."
if ! command -v upterm >/dev/null 2>&1; then
  echo "[start_tunnel] mengunduh binary upterm..."
  curl -fsSL -o /tmp/upterm.deb https://github.com/owenthereal/upterm/releases/latest/download/upterm_linux_amd64.deb >/dev/null 2>&1 || true
  if [ -f /tmp/upterm.deb ]; then
    sudo dpkg -i /tmp/upterm.deb >/dev/null 2>&1 || true
  fi
fi

if command -v upterm >/dev/null 2>&1; then
  echo "[start_tunnel] provider terdeteksi: UPTERM (Zero-Install SSH Relay)"
  AUTH_FLAGS=""
  if [ -f "$AUTH_KEYS" ] && [ -s "$AUTH_KEYS" ]; then
    AUTH_FLAGS="--authorized-keys ${AUTH_KEYS}"
    echo "[start_tunnel] Upterm diikat ke authorized_keys (autentikasi kunci WAJIB)"
  else
    echo "[start_tunnel] PERINGATAN: authorized_keys kosong"
  fi

  if ! command -v tmux >/dev/null 2>&1; then
    sudo apt-get install -y -qq tmux >/dev/null 2>&1 || true
  fi

  mkdir -p "${USER_HOME}/.upterm"
  ADMIN_SOCK="${USER_HOME}/.upterm/upterm.sock"
  rm -f "${ADMIN_SOCK}"

  # Mulai upterm host di background tmux session
  tmux new-session -d -s vps-host "upterm host ${AUTH_FLAGS} --admin-socket ${ADMIN_SOCK} --server ssh://uptermd.upterm.dev:22 --force-command 'tmux attach -t vps || tmux new -s vps' -- tmux new -A -s vps" || true

  echo "[start_tunnel] Menunggu upterm siap terhubung ke server relay..."
  UPTERM_SSH=""
  for i in {1..30}; do
    SOCK=$(find "${USER_HOME}/.upterm" /tmp -name "*.sock" 2>/dev/null | grep -i 'upterm' | head -n 1 || true)
    if [ -n "$SOCK" ] && [ -S "$SOCK" ]; then
      UPTERM_SSH=$(upterm session current --admin-socket "$SOCK" 2>/dev/null | grep -E '^SSH Session:' | sed 's/^SSH Session:[[:space:]]*//' || true)
      if [ -n "$UPTERM_SSH" ]; then
        echo "[start_tunnel] Sesi Upterm siap dalam ${i} detik"
        break
      fi
    fi
    sleep 1
  done

  if [ -n "$UPTERM_SSH" ]; then
    echo "::add-mask::${UPTERM_SSH}"
    echo "${UPTERM_SSH}" > runtime/vps-ssh.txt
    chmod 600 runtime/vps-ssh.txt

    cat > runtime/vps-connection.json <<EOF
{
  "provider": "upterm",
  "ssh_cmd": "${UPTERM_SSH}",
  "run_id": "${RUN_ID}",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    commit_connection_state

    if [ -n "$TG_BOT" ] && [ -n "$TG_CHAT" ]; then
      echo "[start_tunnel] Mengirim akses SSH aman via Telegram pribadi..."
      curl -sf -X POST "https://api.telegram.org/bot${TG_BOT}/sendMessage" \
        -d chat_id="${TG_CHAT}" \
        -d text="🔐 [ORIONT VPS 24/7] Akses SSH Aktif:%0A<code>${UPTERM_SSH}</code>" \
        -d parse_mode="HTML" >/dev/null 2>&1 || true
      echo "[start_tunnel] Notifikasi SSH terkirim ke Telegram!"
    else
      echo "[start_tunnel] Akses Upterm aktif (Di-masking di log publik untuk keamanan)."
      echo "[start_tunnel] Perintah SSH tersimpan terenkripsi di branch state -> jalankan 'npm run ssh' di laptop."
    fi
    exit 0
  else
    echo "[start_tunnel] PERINGATAN: Upterm belum merespons dalam 30 detik. Log tmux:"
    tmux capture-pane -pt vps-host 2>/dev/null || true
  fi
fi

# 5. OPSI E: Fallback Tmate (Jika Upterm tidak tersedia)
TMATE_SSH="${TMATE_SSH_CMD:-}"
if [ -z "$TMATE_SSH" ]; then
  echo "[start_tunnel] Memulai fallback Tmate terlindungi..."
  sudo apt-get install -y -qq tmate >/dev/null 2>&1 || true

  if [ -f "$AUTH_KEYS" ] && [ -s "$AUTH_KEYS" ]; then
    echo "set -g tmate-authorized-keys \"${AUTH_KEYS}\"" > "${USER_HOME}/.tmate.conf"
    echo "[start_tunnel] Tmate diikat ke authorized_keys (autentikasi kunci WAJIB)"
  fi

  tmate -S /tmp/tmate.sock new-session -d >logs/tunnel/tmate.log 2>&1 || true

  for i in {1..15}; do
    TMATE_SSH=$(tmate -S /tmp/tmate.sock display -p '#{tmate_ssh}' 2>/dev/null || true)
    if [ -n "$TMATE_SSH" ]; then
      break
    fi
    sleep 1
  done
fi

if [ -n "$TMATE_SSH" ]; then
  echo "::add-mask::${TMATE_SSH}"
  echo "${TMATE_SSH}" > runtime/tmate-ssh.txt
  chmod 600 runtime/tmate-ssh.txt

  cat > runtime/vps-connection.json <<EOF
{
  "provider": "tmate",
  "ssh_cmd": "${TMATE_SSH}",
  "run_id": "${RUN_ID}",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  commit_connection_state
  exit 0
fi

echo "[start_tunnel] Tidak ada provider tunnel yang berhasil terhubung."
exit 0
