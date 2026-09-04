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
echo "[backup_final] selesai"
