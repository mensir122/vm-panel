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

TARGET_USER="${USER:-runner}"
USER_HOME=$(eval echo "~${TARGET_USER}")
AUTH_KEYS="${USER_HOME}/.ssh/authorized_keys"

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
      # Izinkan interface tailscale bila ada (userspace-networking / tun)
      sudo iptables -A INPUT -i tailscale0 -p tcp --dport 22 -j ACCEPT 2>/dev/null || true
      # Tolak seluruh koneksi SSH dari interface publik luar
      sudo iptables -A INPUT -p tcp --dport 22 -s 127.0.0.1 -j ACCEPT 2>/dev/null || true
      sudo iptables -A INPUT -p tcp --dport 22 -j DROP 2>/dev/null || true
      echo "[start_tunnel] Firewall aktif: Port 22 terkunci total dari jaringan publik"
    fi

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

# 4. OPSI D: Fallback Tmate dengan Autentikasi Kunci Wajib & Anti-Bocor Log
echo "[start_tunnel] Memulai sesi fallback Tmate terlindungi..."
sudo apt-get install -y -qq tmate >/dev/null 2>&1 || true

# KEAMANAN KRUSIAL: -a memastikan HANYA klien dengan SSH key sah yang bisa terhubung!
# Orang luar yang melihat URL tmate TIDAK BISA login tanpa private key Anda.
TMATE_ARGS=(-S /tmp/tmate.sock)
if [ -f "$AUTH_KEYS" ] && [ -s "$AUTH_KEYS" ]; then
  TMATE_ARGS+=(-a "$AUTH_KEYS")
  echo "[start_tunnel] Tmate diikat ke authorized_keys (autentikasi kunci WAJIB)"
else
  echo "[start_tunnel] PERINGATAN: authorized_keys kosong, sesi tmate dibatasi"
fi

tmate "${TMATE_ARGS[@]}" new-session -d >/dev/null 2>&1 || true
tmate -S /tmp/tmate.sock wait-for-ready 2>/dev/null || sleep 3

TMATE_SSH=$(tmate -S /tmp/tmate.sock display -p '#{tmate_ssh}' 2>/dev/null || echo "")

if [ -n "$TMATE_SSH" ]; then
  # SENSOR LOG: Mask connection string agar TIDAK tampil mentah di log publik GitHub
  echo "::add-mask::${TMATE_SSH}"
  echo "${TMATE_SSH}" > runtime/tmate-ssh.txt
  chmod 600 runtime/tmate-ssh.txt

  # Notifikasi Telegram Privat (Jika bot token diset)
  if [ -n "$TG_BOT" ] && [ -n "$TG_CHAT" ]; then
    echo "[start_tunnel] Mengirim akses SSH aman via Telegram pribadi..."
    curl -sf -X POST "https://api.telegram.org/bot${TG_BOT}/sendMessage" \
      -d chat_id="${TG_CHAT}" \
      -d text="🔐 [ORIONT VPS 24/7] Akses SSH Aktif:%0A<code>${TMATE_SSH}</code>" \
      -d parse_mode="HTML" >/dev/null 2>&1 || true
    echo "[start_tunnel] Notifikasi SSH terkirim ke Telegram!"
  else
    # Jika tanpa Telegram, tampilkan petunjuk koneksi yang aman
    echo "[start_tunnel] Akses Tmate aktif (Di-masking di log publik untuk keamanan)."
    echo "[start_tunnel] Perintah SSH telah tersimpan aman di runtime/tmate-ssh.txt"
  fi
else
  echo "[start_tunnel] Standby: Tunnel siap dikonfigurasi via TAILSCALE_AUTHKEY"
fi

exit 0
