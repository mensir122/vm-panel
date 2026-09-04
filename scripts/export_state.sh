#!/usr/bin/env bash
# export_state.sh — AMBIL DATA SAYA: unduh state terenkripsi terakhir dari
# GitHub Actions → file lokal siap disimpan. Untuk pemula: lihat
# docs/DATA-GUIDE.md. Tidak perlu memahami kode — jalankan dan ikuti output.
#
# Pemakaian: bash scripts/export_state.sh [nama-file-output.enc]
# Prasyarat: gh auth login (akun pemilik repo) — itu saja.
set -euo pipefail

OUT="${1:-vm-data-$(date +%Y%m%d-%H%M%S).enc}"
REPO="${GITHUB_REPOSITORY:-mensir122/vm-panel}"

echo "[export_state] mencari state terenkripsi terakhir di ${REPO}..."
ART_ID=$(gh api "repos/${REPO}/actions/artifacts?name=vm-state" \
  --jq '[.artifacts[] | select(.expired == false)][0].id // empty')

if [ -z "$ART_ID" ]; then
  echo "[export_state] TIDAK ADA state tersimpan (VM belum pernah jalan / artifact expired)."
  echo "[export_state] Jalankan dulu workflow vm di Actions, lalu coba lagi."
  exit 1
fi

RUN_OF_ART=$(gh api "repos/${REPO}/actions/artifacts/${ART_ID}" --jq '.run_id')
CREATED=$(gh api "repos/${REPO}/actions/artifacts/${ART_ID}" --jq '.created_at')
echo "[export_state] artifact ditemukan (run ${RUN_OF_ART}, dibuat ${CREATED})"

gh api "repos/${REPO}/actions/artifacts/${ART_ID}/zip" > "${OUT}.zip"
python3 - "$OUT" <<'PY'
import zipfile, sys
out = sys.argv[1]
z = zipfile.ZipFile(out + '.zip')
enc = [n for n in z.namelist() if n.endswith('.enc') and '..' not in n]
if not enc:
    raise SystemExit('tidak ada file .enc di artifact')
open(out, 'wb').write(z.read(enc[0]))
print(f"[export_state] diekstrak: {enc[0]}")
PY
rm -f "${OUT}.zip"

echo ""
echo "============================================================"
echo "  DATA ANDA TERSIMPAN: ${OUT}"
echo "============================================================"
echo "  File ini TERENKRIPSI (AES-256-GCM). Yang bisa membukanya"
echo "  HANYA pemilik VPANEL_MASTER_KEY (ada di .env Anda)."
echo ""
echo "  Simpan file ini di tempat aman (flashdisk/Google Drive)."
echo "  Cara mengembalikan datanya: lihat docs/DATA-GUIDE.md"
echo "  (panduan bahasa awam, langkah demi langkah)."
echo "============================================================"
