// lib/fsutil.js — operasi file atomic (DESIGN.md §25: "gunakan operasi file atomic").
// Pola: tulis ke file sementara DI DIREKTORI YANG SAMA + fsync + rename.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { VmPanelError, NOT_FOUND } from './errors.js';

/** mkdir recursive, idempotent. Return dir. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Tulis data ke filePath secara atomic:
 * 1. tulis ke `<filePath>.tmp-<random>` di direktori yang sama (flag 'wx')
 * 2. fsync
 * 3. rename (atomic; menimpa existing file)
 * @param {string} filePath
 * @param {string|Buffer|Uint8Array} data
 * @returns {string} filePath
 */
export function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(
    dir,
    `${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp mungkin sudah tidak ada */
    }
    throw e;
  }
  return filePath;
}

/** atomicWriteFile untuk JSON (pretty-printed + newline). */
export function atomicWriteJson(filePath, obj) {
  return atomicWriteFile(filePath, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Baca + parse JSON file. ENOENT -> VmPanelError NOT_FOUND.
 * JSON invalid -> SyntaxError dari JSON.parse (dibiarkan naik).
 */
export function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new VmPanelError(NOT_FOUND, `file tidak ditemukan: ${filePath}`, { path: filePath });
    }
    throw e;
  }
  return JSON.parse(raw);
}
