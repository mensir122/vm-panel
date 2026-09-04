#!/usr/bin/env bash
# restore.sh — restore dari backup terbaru/manual. Argumentasi: BACKUP_ID opsional.
# Konfirmasi dua tahap ada di vmctl/panel; script ini untuk disaster recovery manual.
# Desain: docs/DESIGN.md §5.5, docs/OPERATIONS.md (troubleshooting DB corrupt).
set -euo pipefail

BACKUP_ID="${1:-}"
if [ -z "$BACKUP_ID" ]; then
  echo "[restore] usage: restore.sh <backup-id>   (list: node -e \"...listBackups...\")"
  exit 2
fi

echo "[restore] restore dari ${BACKUP_ID} (writer WAJIB sudah dihentikan — §9)"
node --input-type=module -e "
import { BackupManager } from './manager/backup_manager/index.js';
import { RestoreManager } from './manager/restore_manager/index.js';
const bm = new BackupManager({ dataDir: 'data', backupsRoot: 'backups', lockDir: 'runtime/locks' });
const rm = new RestoreManager({ dataDir: 'data', backupsRoot: 'backups', backupManager: bm });
const report = rm.restoreBackup('${BACKUP_ID}', { dryRun: false });
console.log('[restore] restored:', report.restored.join(','), '| warnings:', report.warnings.length, '| rollback:', report.rollbackDir);
"
echo "[restore] selesai — jalankan scripts/verify_state.sh lalu start manager"
