#!/usr/bin/env bash
# restore_state.sh - unduh artifact 'vm-state' (TERENKRIPSI) dari run vm.yml
# sebelumnya, dekripsi, katalogkan backup, siap dipakai manager.
# Fallback: fresh start. Desain: docs/DESIGN.md S15.2, S16.2, S9.5.
# Repo PUBLIC: artifact plaintext TIDAK PERNAH di-upload - hanya vm-state.enc.
set -euo pipefail

echo "[restore_state] mulai"

REPO="${GITHUB_REPOSITORY:-}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
MASTER_KEY="${VPANEL_MASTER_KEY:-}"

if [ -z "$REPO" ] || [ -z "$GH_TOKEN" ]; then
  echo "[restore_state] GITHUB_REPOSITORY/GH_TOKEN tidak ada - fallback FRESH START (dev)"
  echo "restored_from=fresh" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

# Cari artifact 'vm-state' terbaru (exclude run saat ini).
RUN_ID="${GITHUB_RUN_ID:-}"
ART_ID=$(gh api "repos/${REPO}/actions/artifacts?name=vm-state" \
  --jq "[.artifacts[] | select(.expired == false and (.run_id|tostring) != \"${RUN_ID}\")][0].id // empty" 2>/dev/null || true)

mkdir -p .state-download
ENC_FILE=""

if [ -n "$ART_ID" ]; then
  RUN_OF_ART=$(gh api "repos/${REPO}/actions/artifacts/${ART_ID}" --jq '.run_id')
  echo "[restore_state] unduh artifact ${ART_ID} (run ${RUN_OF_ART})"
  gh api "repos/${REPO}/actions/artifacts/${ART_ID}/zip" > .state-download/state.zip

  # Ekstrak hanya file .enc (whitelist; tolak traversal) - LANGSUNG ke
  # .state-download/ agar find di bawah menemukannya.
  python3 - <<'PY'
import zipfile
z = zipfile.ZipFile('.state-download/state.zip')
found = False
for n in z.namelist():
    if n.endswith('.enc') and '..' not in n:
        z.extract(n, '.state-download')
        found = True
if not found:
    raise SystemExit('tidak ada file .enc di artifact')
print("[restore_state] container .enc diekstrak")
PY
  ENC_FILE=$(find .state-download -name '*.enc' | head -1)
  STATE_SOURCE="artifact run ${RUN_OF_ART}"
else
  # FALLBACK VAULT BRANCH: artifact tidak ada/kedaluwarsa -> ambil dari
  # branch 'state' (backup permanen otomatis yang di-commit tiap shutdown).
  echo "[restore_state] artifact tidak tersedia - coba vault branch 'state'..."
  VAULT_SHA=$(gh api "repos/${REPO}/contents/vm-state.enc?ref=state" --jq '.sha // empty' 2>/dev/null || true)
  if [ -n "$VAULT_SHA" ]; then
    gh api "repos/${REPO}/contents/vm-state.enc?ref=state" --jq '.content' 2>/dev/null | base64 -d > .state-download/vm-state.enc
    ENC_FILE=".state-download/vm-state.enc"
    STATE_SOURCE="vault branch 'state'"
    echo "[restore_state] container dari vault branch 'state' diunduh"
  else
    echo "[restore_state] tidak ada artifact DAN tidak ada vault branch 'state' - FRESH START"
    echo "restored_from=fresh" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi
fi

# Dekripsi container -> backups/ terisi ulang (plaintext hanya hidup di runner
# ephemeral ini; sumber kebenaran tetap artifact terenkripsi).
if [ -z "$MASTER_KEY" ]; then
  echo "[restore_state] VPANEL_MASTER_KEY tidak ada - TIDAK BISA dekripsi (aman: data tidak bocor ke log). Fallback FRESH START."
  echo "restored_from=fresh" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi
node scripts/state-container.mjs decrypt "$ENC_FILE" backups "$MASTER_KEY"

# Pilih manifest backup terbaru yang baru diekstrak -> katalogkan -> restore.
LATEST_MANIFEST=$(find backups -name 'manifest.json' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)
if [ -z "$LATEST_MANIFEST" ]; then
  echo "[restore_state] tidak ada manifest di container - FRESH START"
  echo "restored_from=fresh" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi
BACKUP_DIR=$(dirname "$LATEST_MANIFEST")
BACKUP_ID=$(node --input-type=module -e "
import fs from 'node:fs';
console.log(JSON.parse(fs.readFileSync('${LATEST_MANIFEST}', 'utf8')).backupId);
")
echo "[restore_state] restore dari ${BACKUP_DIR} (id ${BACKUP_ID})"

node --input-type=module -e "
import { BackupManager } from './manager/backup_manager/index.js';
import { RestoreManager } from './manager/restore_manager/index.js';
const bm = new BackupManager({ dataDir: 'data', backupsRoot: 'backups', lockDir: 'runtime/locks' });
bm.catalogExternal({ backupId: '${BACKUP_ID}', dir: '${BACKUP_DIR}', trigger: 'external', retentionClass: 'latest', runnerId: '${RUN_OF_ART}' });
const rm = new RestoreManager({ dataDir: 'data', backupsRoot: 'backups', backupManager: bm });
const report = rm.restoreBackup('${BACKUP_ID}', { dryRun: false });
console.log('[restore_state] restored:', report.restored.join(','), '| warnings:', report.warnings.length);
" || { echo "[restore_state] RESTORE GAGAL - fallback FRESH START"; echo "restored_from=fresh" >> "${GITHUB_OUTPUT:-/dev/null}"; exit 0; }

# Bersihkan plaintext di runner ini setelah restore (tidak dibutuhkan lagi;
# sumber kebenaran tetap artifact terenkripsi).
rm -f "$ENC_FILE"
rm -rf .state-download
echo "restored_from=${BACKUP_DIR}" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "[restore_state] selesai"
