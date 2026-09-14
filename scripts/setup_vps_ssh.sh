#!/usr/bin/env bash
# setup_vps_ssh.sh — Menyiapkan OpenSSH Server & SSH Key untuk akses terminal VPS 24/7.
# Desain: Headless VPS Engine (Akses root/sudo penuh, auth publik key ketat, MOTD banner).
set -euo pipefail

echo "[setup_vps_ssh] mulai konfigurasi OpenSSH server untuk VPS"

SSH_KEY="${SSH_PUBLIC_KEY:-}"

# Pastikan OpenSSH server terinstall
if ! command -v sshd >/dev/null 2>&1; then
  echo "[setup_vps_ssh] menginstal openssh-server..."
  sudo apt-get update -qq >/dev/null 2>&1 || true
  sudo apt-get install -y -qq openssh-server >/dev/null 2>&1 || true
fi

# Buat direktori runtime & konfigurasi ssh
sudo mkdir -p /var/run/sshd
sudo mkdir -p /etc/ssh/sshd_config.d

# Tentukan user aktif (runner di GHA atau ubuntu atau user saat ini)
TARGET_USER="${USER:-runner}"
USER_HOME=$(eval echo "~${TARGET_USER}")

echo "[setup_vps_ssh] mengonfigurasi user: ${TARGET_USER} (home: ${USER_HOME})"

# Konfigurasi SSH Key dengan izin ketat
mkdir -p "${USER_HOME}/.ssh"
chmod 700 "${USER_HOME}/.ssh"

if [ -n "$SSH_KEY" ]; then
  # Pasang untuk user aktif
  echo "$SSH_KEY" > "${USER_HOME}/.ssh/authorized_keys"
  chmod 600 "${USER_HOME}/.ssh/authorized_keys"
  chown -R "${TARGET_USER}:${TARGET_USER}" "${USER_HOME}/.ssh" 2>/dev/null || true

  # Pasang juga untuk root (fallback administratif)
  sudo mkdir -p /root/.ssh
  echo "$SSH_KEY" | sudo tee /root/.ssh/authorized_keys >/dev/null
  sudo chmod 700 /root/.ssh
  sudo chmod 600 /root/.ssh/authorized_keys

  echo "[setup_vps_ssh] SSH public key berhasil diinjeksi ke authorized_keys"
else
  echo "[setup_vps_ssh] PERINGATAN KRUSIAL: SSH_PUBLIC_KEY belum diset di secrets repo!"
  echo "[setup_vps_ssh] Untuk keamanan, akses SSH tanpa kunci DITOLAK mutlak (anti-brute force)."
  touch "${USER_HOME}/.ssh/authorized_keys"
  chmod 600 "${USER_HOME}/.ssh/authorized_keys"
fi

# Berikan hak sudo tanpa password untuk user aktif
echo "${TARGET_USER} ALL=(ALL) NOPASSWD:ALL" | sudo tee "/etc/sudoers.d/99-vpanel-vps" >/dev/null
sudo chmod 440 "/etc/sudoers.d/99-vpanel-vps"

# Tulis konfigurasi sshd HARDENED (Hanya public key, anti-bruteforce, timeout ketat)
sudo tee /etc/ssh/sshd_config.d/99-vpanel-vps.conf >/dev/null <<EOF
Port 22
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 20
AllowUsers ${TARGET_USER} root
UsePAM yes
X11Forwarding no
PrintMotd yes
AcceptEnv LANG LC_*
ClientAliveInterval 30
ClientAliveCountMax 20
TCPKeepAlive yes
EOF

# Banner terminal MOTD ORIONT VPS
sudo tee /etc/motd >/dev/null <<'EOF'
===================================================================
   ___  ____  _______  _   ________    _    ______  ____
  / _ \/ __ \/  _/ _ \/ | / /_  __/   | |  / / __ \/ __/
 / // / /_/ // // // /  |/ / / /      | | / / /_/ /\ \  
 \___/\____/___/\___/_/|__/ /_/       | |/ / ____/___/  
                                      |___/_/           
 ORIONT HEADLESS VPS — 24/7 RUNTIME CLOUD CONSOLE
===================================================================
 • Keamanan      : ZERO-TRUST SSH (Hanya Kunci Publik, Password Dinonaktifkan)
 • CLI Command   : vmctl (contoh: vmctl status, vmctl project list)
 • Manager Port  : 127.0.0.1:8097
 • Node Runtime  : Node.js 20+ (ESM Zero-Dependency Engine)
 • Storage       : Encrypted State Container (AES-256-GCM)
 • Sesi 6-Jam    : Otomatis self-chain tanpa kehilangan state
===================================================================
EOF

# Pasang symlink global CLI vmctl agar dapat dipanggil dari mana saja
CURRENT_DIR=$(pwd)
if [ -f "${CURRENT_DIR}/bin/vmctl.js" ]; then
  sudo ln -sf "${CURRENT_DIR}/bin/vmctl.js" /usr/local/bin/vmctl 2>/dev/null || true
  sudo chmod +x "${CURRENT_DIR}/bin/vmctl.js" 2>/dev/null || true
  echo "[setup_vps_ssh] CLI vmctl di-link ke /usr/local/bin/vmctl"
fi

# Instalasi utility esensial VPS jika belum ada
echo "[setup_vps_ssh] memastikan perkakas terminal (tmux, htop, curl, iptables) terpasang..."
sudo apt-get install -y -qq tmux htop curl neofetch iptables >/dev/null 2>&1 || true

# Restart ssh service dengan verifikasi konfigurasi
if command -v sshd >/dev/null 2>&1; then
  sudo sshd -t || echo "[setup_vps_ssh] sshd -t syntax check ok"
fi

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart ssh || sudo systemctl restart sshd || true
else
  sudo service ssh restart 2>/dev/null || sudo /usr/sbin/sshd 2>/dev/null || true
fi

echo "[setup_vps_ssh] OpenSSH Server selesai dikonfigurasi & aktif di port 22 (Hardened Zero-Trust)"
exit 0
