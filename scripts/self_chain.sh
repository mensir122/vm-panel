#!/usr/bin/env bash
# self_chain.sh — dipanggil keepalive.sh; dipisah agar bisa dijalankan manual.
# (Isi logika dispatch ada di keepalive.sh; script ini wrapper + catatan.)
set -euo pipefail

echo "[self_chain] wrapper — logika utama di akhir scripts/keepalive.sh"
if [ -f runtime/pid/manager-launcher.pid ]; then
  echo "[self_chain] manager masih hidup (pid $(cat runtime/pid/manager-launcher.pid))"
fi
echo "[self_chain] selesai (no-op)"
