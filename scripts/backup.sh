#!/usr/bin/env bash
# backup.sh — backup manual dari CLI (setara vmctl backup create).
set -euo pipefail

echo "[backup] mulai"
node --input-type=module -e "
import { BackupManager } from './manager/backup_manager/index.js';
const bm = new BackupManager({ dataDir: 'data', backupsRoot: 'backups', lockDir: 'runtime/locks' });
const res = await bm.createBackup({ trigger: 'manual', retentionClass: 'manual' });
console.log('[backup] created:', res.backupId);
bm.close?.();
"
echo "[backup] selesai"
