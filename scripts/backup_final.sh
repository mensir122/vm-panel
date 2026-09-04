#!/usr/bin/env bash
# backup_final.sh — final backup sebelum shutdown (kelas manual, tanpa rate-limit).
# Desain: docs/DESIGN.md §15.2 t-08m, §9.
set -euo pipefail

echo "[backup_final] mulai"
node --input-type=module -e "
import { BackupManager } from './manager/backup_manager/index.js';
const bm = new BackupManager({ dataDir: 'data', backupsRoot: 'backups', lockDir: 'runtime/locks' });
const res = await bm.createBackup({ trigger: 'pre-shutdown', retentionClass: 'manual' });
const v = await bm.verifyBackup(res.backupId);
if (!v.ok && v.verification_status !== 'valid' && v.verification_status !== undefined) {
  console.error('[backup_final] VERIFIKASI GAGAL:', v.error ?? v.verification_status);
  process.exit(1);
}
console.log('[backup_final] backup final valid:', res.backupId);
bm.close?.();
"
echo "[backup_final] selesai"
