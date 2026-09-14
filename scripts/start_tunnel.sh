#!/usr/bin/env bash
# start_tunnel.sh — Menghubungkan Headless VPS ke Tailscale / Cloudflare Tunnel / Tmate.
# Desain: Reverse tunnel multi-provider agar SSH port 22 dan service dapat diakses publik/mesh.
set -euo pipefail

echo "[start_tunnel] mulai inisialisasi reverse tunnel jaringan"
mkdir -p logs/tunnel runtime/pid

TS_KEY="${TAILSCALE_AUTHKEY:-}"
CF_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
NGROK_TOKEN="${NGROK_AUTHTOKEN:-}"

# 1. OPSI A: Tailscale Mesh VPN (Pilihan Terbaik & Paling Stabil)
if [ -n "$TS_KEY" ]; then
  echo "[start_tunnel] provider terdeteksi: TAILSCALE"
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
  if sudo tailscale up --authkey="${TS_KEY}" --hostname="vpanel-vps" --ssh=true --accept-routes >logs/tunnel/tailscale-up.log 2>&1; then
    TS_IP=$(tailscale ip -4 2>/dev/null || echo "100.x.y.z")
    echo "[start_tunnel] KONEKSI TAILSCALE BERHASIL!"
    echo "[start_tunnel] Hostname Tailscale: vpanel-vps"
    echo "[start_tunnel] IP Tailscale      : ${TS_IP}"
    echo "[start_tunnel] Perintah SSH       : ssh runner@vpanel-vps (atau ssh runner@${TS_IP})"
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
  echo "[start_tunnel] Cloudflare tunnel daemon berjalan di background (PID $(cat runtime/pid/tunnel-launcher.pid))"
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
  echo "[start_tunnel] Ngrok tunnel aktif: ${NGROK_URL}"
  exit 0
fi

# 4. OPSI D: Fallback Tmate (Instan, Zero Config, Tanpa Token)
echo "[start_tunnel] Tidak ada secret tunnel (TAILSCALE_AUTHKEY/CLOUDFLARE_TUNNEL_TOKEN) yang diset."
echo "[start_tunnel] Memulai sesi fallback Tmate..."
sudo apt-get install -y -qq tmate >/dev/null 2>&1 || true

tmate -S /tmp/tmate.sock new-session -d >/dev/null 2>&1 || true
tmate -S /tmp/tmate.sock wait-for-ready 2>/dev/null || sleep 3

TMATE_SSH=$(tmate -S /tmp/tmate.sock display -p '#{tmate_ssh}' 2>/dev/null || echo "")
if [ -n "$TMATE_SSH" ]; then
  echo "[start_tunnel] ========================================================"
  echo "[start_tunnel] AKSES SSH FALLBACK TMATE AKTIF:"
  echo "[start_tunnel]   ${TMATE_SSH}"
  echo "[start_tunnel] ========================================================"
  echo "${TMATE_SSH}" > runtime/tmate-ssh.txt
else
  echo "[start_tunnel] Standby: Tunnel belum aktif, jalankan lokal atau sediakan TAILSCALE_AUTHKEY"
fi

exit 0
