// lib/env.js — loader .env sederhana (tanpa dependency).
// Dipakai oleh manager, panel, dan script setup agar VPANEL_MASTER_KEY
// konsisten di semua proses (kesalahan kunci = TOTP gagal didekripsi).
import fs from 'node:fs';
import path from 'node:path';

/**
 * Baca .env di rootDir dan set process.env (tanpa menimpa yang sudah ada).
 * Mendukung: KEY=VALUE, komentar #, kutip ganda/tunggal, baris kosong.
 * @returns {number} jumlah variabel yang di-set
 */
export function loadDotEnv(rootDir, { override = false } = {}) {
  const p = path.join(rootDir, '.env');
  if (!fs.existsSync(p)) return 0;
  let count = 0;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (key && (override || process.env[key] === undefined)) {
      process.env[key] = val;
      count++;
    }
  }
  return count;
}
