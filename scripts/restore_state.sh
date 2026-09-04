#!/usr/bin/env bash
# restore_state.sh — unduh backup valid terakhir dari artifact 'vm-state-*'
# run vm.yml sebelumnya; fallback: fresh start (dev bootstrap).
# Desain: docs/DESIGN.md §15.2, §16.2. Tanpa secret di log.
set -euo pipefail

echo "[restore_state] mulai"

REPO="${GITHUB_REPOSITORY:-}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

if [ -z "$REPO" ] || [ -z "$GH_TOKEN" ]; then
  echo "[restore_state] GITHUB_REPOSITORY/GH_TOKEN tidak ada → fallback FRESH START (dev)"
  echo "restored_from=fresh" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

# Cari artifact vm-state-* terbaru (exclude artifact run saat ini).
RUN_ID="${GITHUB_RUN_ID:-}"
ART_ID=$(gh api "repos/${REPO}/actions/artifacts?name=vm-state" \
  --jq "[.artifacts[] | select(.expired == false and (.run_id|tostring) != \"${RUN_ID}\")][0].id // empty" 2>/dev/null || true)

if [ -z "$ART_ID" ]; then
  echo "[restore_state] tidak ada artifact state sebelumnya → FRESH START"
  echo "restored_from=fresh" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

RUN_OF_ART=$(gh api "repos/${REPO}/actions/artifacts/${ART_ID}" --jq '.run_id')
echo "[restore_state] unduh artifact ${ART_ID} (run ${RUN_OF_ART})"
mkdir -p .state-download
gh api "repos/${REPO}/actions/artifacts/${ART_ID}/zip" > .state-download/state.zip

# Ekstrak aman: tarik hanya backups/** (whitelist prefix; tolak traversal).
python3 - <<'PY'
import zipfile, os
z = zipfile.ZipFile('.state-download/state.zip')
for n in z.namelist():
    if not n.startswith('backups/') or '..' in n:
        continue
    z.extract(n)
print("[restore_state] ekstraksi aman selesai")
PY

# Pilih backup manual/weekly/latest terbaru yang manifest-nya valid → data/.
LATEST=$(find backups -name 'manifest.json' 2>/dev/null | sort | tail -1 || true)
if [ -z "$LATEST" ]; then
  echo "[restore_state] tidak ada manifest valid di artifact → FRESH START"
  echo "restored_from=fresh" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi
BACKUP_DIR=$(dirname "$LATEST")
echo "[restore_state] restore dari ${BACKUP_DIR}"

# Restore DB via node (RestoreManager; integrity + atomic swap + rollback point).
node --input-type=module -e "
import { BackupManager } from './manager/backup_manager/index.js';
import { RestoreManager } from './manager/restore_manager/index.js';
import fs from 'node:fs';
const dir = '${BACKUP_DIR}';
const manifest = JSON.parse(fs.readFileSync(dir + '/manifest.json', 'utf8'));
const bm = new BackupManager({ dataDir: 'data', backupsRoot: 'backups', lockDir: 'runtime/locks' });
bm.catalogSeed(manifest, dir); // daftarkan snapshot ke katalog tanpa copy penuh
const rm = new RestoreManager({ dataDir: 'data', backupsRoot: 'backups', backupManager: bm });
const report = rm.restoreBackup(manifest.backupId, { dryRun: false });
console.log('[restore_state] restored:', report.restored.join(','), '| warnings:', report.warnings.length);
" || { echo "[restore_state] RESTORE GAGAL — fallback FRESH START"; echo "restored_from=fresh" >> "${GITHUB_OUTPUT:-/dev/null}"; exit 0; }

echo "restored_from=${BACKUP_DIR}" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "[restore_state] selesai"
