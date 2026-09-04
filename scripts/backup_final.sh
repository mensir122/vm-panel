#!/usr/bin/env bash
# backup_final.sh — final backup sebelum shutdown (kelas manual, tanpa rate-limit),
# lalu ENKRIPSI jadi runtime/vm-state.enc (repo public → artifact wajib terenkripsi).
# Desain: docs/DESIGN.md §15.2 t-08m, §9, §9.5.
set -euo pipefail

echo "[backup_final] mulai"
BACKUP_ID=$(node --input-type=module -e "
import { BackupManager } from './manager/backup_manager/index.js';
const bm = new BackupManager({ dataDir: 'data', backupsRoot: 'backups', lockDir: 'runtime/locks' });
const res = await bm.createBackup({ trigger: 'pre-shutdown', retentionClass: 'manual' });
const v = await bm.verifyBackup(res.backupId);
if (!v.ok && v.verification_status !== 'valid' && v.verification_status !== undefined) {
  console.error('[backup_final] VERIFIKASI GAGAL:', v.error ?? v.verification_status);
  process.exit(1);
}
console.log(res.backupId);
bm.close?.();
")
echo "[backup_final] backup final valid: ${BACKUP_ID}"

# Enkripsi SATU backup dir terbaru → runtime/vm-state.enc (AES-256-GCM,
# kunci = PBKDF2(VPANEL_MASTER_KEY)). Hanya file ini yang di-upload ke
# artifact — plaintext TIDAK PERNAH meninggalkan runner.
node scripts/state-container.mjs encrypt "backups/manual/${BACKUP_ID}" runtime/vm-state.enc "${VPANEL_MASTER_KEY:?VPANEL_MASTER_KEY wajib}"
echo "[backup_final] state terenkripsi: runtime/vm-state.enc"

# --- VAULT BRANCH: commit .enc ke branch 'state' (backup permanen otomatis) ---
# Repo public + branch 'state': file TERENKRIPSI aman di-commit. Ini membuat
# data TIDAK PERNAH hilang walau artifact kedaluwarsa — tanpa unduhan manual.
if [ -n "${GH_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  REPO="${GITHUB_REPOSITORY}"
  COMMIT_MSG="state: ${BACKUP_ID} (auto-encrypted backup)"
  B64=$(base64 -w0 runtime/vm-state.enc)
  vault_put() {
    local OLD_SHA="$1" BODY
    BODY=$(node --input-type=module -e "
      const args = process.argv.slice(2);
      console.log(JSON.stringify({
        message: args[0],
        branch: 'state',
        content: args[1],
        sha: args[2] || undefined,
      }));
    " "${COMMIT_MSG}" "${B64}" "${OLD_SHA}")
    gh api -X PUT "repos/${REPO}/contents/vm-state.enc" --input - <<< "${BODY}" > /dev/null 2>&1
  }
  OLD_SHA=$(gh api "repos/${REPO}/contents/vm-state.enc?ref=state" --jq '.sha // empty' 2>/dev/null || true)
  if vault_put "${OLD_SHA}"; then
    echo "[backup_final] vault branch 'state' diperbarui (backup permanen otomatis)"
  else
    # branch 'state' mungkin belum ada -> buat dari HEAD, lalu retry sekali
    HEAD_SHA=$(gh api "repos/${REPO}/git/refs/heads/${GITHUB_REF_NAME:-main}" --jq '.object.sha' 2>/dev/null || true)
    if gh api -X POST "repos/${REPO}/git/refs" -f ref=refs/heads/state -f sha="${HEAD_SHA}" > /dev/null 2>&1 \
       && vault_put ""; then
      echo "[backup_final] branch 'state' dibuat + backup permanen tersimpan"
    else
      echo "[backup_final] PERINGATAN: vault branch gagal (artifact tetap tersimpan)"
    fi
  fi
else
  echo "[backup_final] GH_TOKEN/GITHUB_REPOSITORY tidak ada — skip vault branch (artifact tetap tersimpan)"
fi

echo "[backup_final] selesai"
