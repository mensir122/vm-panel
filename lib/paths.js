// lib/paths.js — proteksi path traversal & symlink escape (DESIGN.md §12 kasus 15/21).
// Semua path yang diturunkan dari input tidak tepercaya HARUS lewat modul ini.

import path from 'node:path';
import fs from 'node:fs';
import { VmPanelError, PATH_ESCAPE } from './errors.js';

function fail(message, details) {
  throw new VmPanelError(PATH_ESCAPE, message, details);
}

/** True jika candidateReal === rootReal atau berada di bawahnya. */
function inside(rootReal, candidateReal) {
  if (candidateReal === rootReal) return true;
  const withSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return candidateReal.startsWith(withSep);
}

/**
 * Realpath dari prefix terpanjang candidatePath yang sudah ada di disk,
 * plus daftar segmen yang belum ada (urut dari atas ke bawah).
 * Ini yang menutup celah symlink: komponen existing di-resolve fisik.
 */
function deepestReal(candidatePath) {
  let probe = path.resolve(candidatePath);
  const missing = [];
  for (;;) {
    try {
      return { real: fs.realpathSync(probe), missing };
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return { real: probe, missing }; // sampai drive root
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/** Tolak part absolut (POSIX, drive letter Windows, UNC) dan part kosong. */
function rejectAbsolute(part) {
  if (typeof part !== 'string' || part.length === 0) {
    fail('path part kosong atau bukan string', { part: String(part) });
  }
  if (path.isAbsolute(part) || /^[a-zA-Z]:[\\/]/.test(part) || /^\\\\/.test(part)) {
    fail('absolute path ditolak', { part });
  }
}

/** Tolak segmen `..` di mana pun posisinya dalam part (cek segmen raw + normalized). */
function rejectDotDot(part) {
  for (const seg of part.split(/[\\/]+/)) {
    if (seg === '..') fail("path traversal '..' ditolak", { part });
  }
  // Jaga-jaga bentuk obfuscated (mis. "sub/..\\..") yang raw-split tak menangkap:
  const norm = path.normalize(part);
  for (const seg of norm.split(/[\\/]+/)) {
    if (seg === '..') fail("path traversal '..' ditolak", { part });
  }
}

/**
 * Gabungkan rootDir dengan parts secara aman.
 * - Tolak part absolut / `..` (VALIDATION kelas PATH_ESCAPE).
 * - Realpath seluruh prefix yang sudah ada; hasil wajib di dalam root.
 * @returns {string} path absolut di dalam rootDir
 */
export function safeJoin(rootDir, ...parts) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch (e) {
    fail(`root tidak ada atau tidak terbaca: ${rootDir}`, { rootDir, cause: String(e?.message ?? e) });
  }
  for (const part of parts) {
    rejectAbsolute(part);
    rejectDotDot(part);
  }
  const joined = path.resolve(rootReal, ...parts);
  const { real, missing } = deepestReal(joined);
  if (!inside(rootReal, real)) {
    fail('hasil join berada di luar root', { root: rootReal, resolved: real });
  }
  return missing.length > 0 ? path.join(real, ...missing) : real;
}

/**
 * Assert candidatePath berada di dalam rootDir (realpath-aware), return
 * path hasil resolusi fisik bila lolos; throw PATH_ESCAPE bila tidak.
 */
export function assertInside(rootDir, candidatePath) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch (e) {
    fail(`root tidak ada atau tidak terbaca: ${rootDir}`, { rootDir, cause: String(e?.message ?? e) });
  }
  const { real } = deepestReal(path.resolve(candidatePath));
  if (!inside(rootReal, real)) {
    fail('path berada di luar root', { root: rootReal, resolved: real, candidatePath });
  }
  return real;
}

/**
 * Iterasi seluruh isi rootDir (relatif, '/', sorted). Jika ada symlink yang
 * mengarah keluar root (atau tidak bisa diresolusi) -> throw PATH_ESCAPE.
 * Symlink yang menunjuk ke dalam root diperbolehkan tapi tidak diikuti.
 */
export function walkChecked(rootDir) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch (e) {
    fail(`root tidak ada atau tidak terbaca: ${rootDir}`, { rootDir, cause: String(e?.message ?? e) });
  }
  const out = [];
  const visit = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable -> abaikan subtree ini
    }
    for (const ent of entries) {
      const childAbs = path.join(absDir, ent.name);
      const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
      let isSymlink = false;
      try {
        isSymlink = fs.lstatSync(childAbs).isSymbolicLink();
      } catch {
        continue; // hilang di tengah jalan
      }
      if (isSymlink) {
        let target = null;
        try {
          target = fs.realpathSync(childAbs);
        } catch {
          target = null;
        }
        if (!target || !inside(rootReal, target)) {
          fail('symlink keluar dari root', { link: childAbs, target: target ?? '(tidak terresolusi)' });
        }
        out.push(childRel);
        continue; // jangan ikuti symlink -> hindari siklus & double-visit
      }
      out.push(childRel);
      let st = null;
      try {
        st = fs.statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(childAbs, childRel);
    }
  };
  visit(rootReal, '');
  return out.sort();
}
