#!/usr/bin/env bash
# import_state.sh — KEMBALIKAN DATA ANDA dari file .enc ke VM-Panel ini.
# Untuk pemula: lihat docs/DATA-GUIDE.md (langkah demi langkah).
#
# Pemakaian:
#   bash scripts/import_state.sh <file.enc> "PASTE-VPANEL_MASTER_KEY-ANDA"
#
# Prasyarat: manager & panel harus MATI dulu (node manager/index.js belum
# jalan / sudah di-stop) — supaya swap database bersih.
set -euo pipefail

ENC="${1:-}"
KEY="${2:-}"

if [ -z "$ENC" ] || [ ! -f "$ENC" ]; then
  echo "[import_state] usage: bash scripts/import_state.sh <file.enc> \"PASTE-VPANEL_MASTER_KEY\""
  [ -n "$ENC" ] && echo "[import_state] file tidak ditemukan: ${ENC}"
  exit 2
fi
if [ -z "$KEY" ]; then
  echo "[import_state] kunci kosong — kunci ada di .env Anda (baris VPANEL_MASTER_KEY)"
  exit 2
fi

echo "[import_state] dekripsi ${ENC} -> backups/imported/"
node scripts/state-container.mjs decrypt "$ENC" backups/imported "$KEY"

# Ambil backup dir terbaru hasil dekripsi (manifest.json terbaru).
LATEST_MANIFEST=$(find backups/imported -name 'manifest.json' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)
if [ -z "$LATEST_MANIFEST" ]; then
  echo "[import_state] GAGAL: tidak ada manifest hasil dekripsi (key salah?)"
  exit 1
fi
BACKUP_DIR=$(dirname "$LATEST_MANIFEST")
BACKUP_ID=$(node --input-type=module -e "
import fs from 'node:fs';
console.log(JSON.parse(fs.readFileSync('${LATEST_MANIFEST}', 'utf8')).backupId);
")
echo "[import_state] backup dikenali: ${BACKUP_ID}"

# Katalogkan + restore (swap database). Recovery point lama TIDAK dihapus.
node --input-type=module -e "
import { BackupManager } from './manager/backup_manager/index.js';
import { RestoreManager } from './manager/restore_manager/index.js';
const bm = new BackupManager({ dataDir: 'data', backupsRoot: 'backups', lockDir: 'runtime/locks' });
bm.catalogExternal({ backupId: '${BACKUP_ID}', dir: '${BACKUP_DIR}', trigger: 'import', retentionClass: 'manual' });
const rm = new RestoreManager({ dataDir: 'data', backupsRoot: 'backups', backupManager: bm });
const report = rm.restoreBackup('${BACKUP_ID}', { dryRun: false });
console.log('[import_state] restored:', report.restored.join(','));
console.log('[import_state] rollback point:', report.rollbackDir);
" || { echo "[import_state] GAGAL — data lama TIDAK disentuh (aman). Periksa pesan di atas."; exit 1; }

echo ""
echo "============================================================"
echo "  IMPORT SELESAI. Data Anda sudah kembali:"
echo "  - projects/users/audit/services = kondisi saat backup dibuat"
echo "  - Jalankan: npm start  dan  npm run start:panel"
echo "  - Login tetap pakai akun & TOTP Anda."
echo "============================================================"
