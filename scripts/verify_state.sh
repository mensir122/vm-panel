#!/usr/bin/env bash
# verify_state.sh — integrity check semua DB yang ada sebelum manager start.
# Desain: docs/DESIGN.md §5.5, §16.2 langkah 5.
set -euo pipefail

echo "[verify_state] integrity check DB..."
node --input-type=module -e "
import { openDatabase } from './lib/db.js';
import fs from 'node:fs';
const DBS = ['platform','projects','services','deployments','health','backups','users','locks'];
let checked = 0;
for (const name of DBS) {
  const p = 'data/' + name + '.db';
  if (!fs.existsSync(p)) continue;
  const h = openDatabase(p, { schemaName: name });
  const ic = h.integrityCheck();
  h.close();
  if (!ic.ok) { console.error('[verify_state] INTEGRITY GAGAL: ' + name); process.exit(1); }
  checked++;
  console.log('[verify_state] ' + name + ': ok');
}
console.log('[verify_state] ' + checked + ' DB tervalidasi');
"
echo "[verify_state] selesai"
