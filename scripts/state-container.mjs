#!/usr/bin/env node
// scripts/state-container.mjs — container state TERENKRIPSI untuk artifact
// GitHub Actions (repo public → artifact bisa diunduh siapa saja → WAJIB
// terenkripsi sebelum upload).
//
// Format file .enc (JSON):
//   { magic: 'VPSTATE1', kdf: {salt, iterations}, envelope: {iv, tag, ct} }
//   envelope = AES-256-GCM atas gzip(JSON {files: {relpath: base64}})
// Kunci = PBKDF2-SHA256(masterKey, salt, 600k) 32 byte (AES-256-GCM).
//
// Pemakaian:
//   node scripts/state-container.mjs encrypt <srcDir> <outFile> <masterKey>
//   node scripts/state-container.mjs decrypt <encFile> <outDir> <masterKey>
//
// Desain: docs/DESIGN.md §9.5 (anti-destruktif), §13 (kripto), §15 (artifact).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { aesEncrypt, aesDecrypt, deriveKey } from '../lib/crypto.js';

const MAGIC = 'VPSTATE1';
const KDF_SALT = 'vm-state-artifact';
const KDF_LABEL = 'state-container';

function key32(masterKey) {
  // deriveKey(secret, salt, label) — PBKDF2 600k di dalam lib/crypto.js.
  return deriveKey(String(masterKey), KDF_SALT, KDF_LABEL);
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, base));
    else if (e.isFile()) out.push(full);
    // symlink di-skip (keamanan — container hanya berisi file reguler)
  }
  return out;
}

function relPosix(full, base) {
  const rel = path.relative(base, full).split(path.sep).join('/');
  if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) {
    throw new Error(`path keluar container: ${rel}`);
  }
  return rel;
}

function buildContainer(srcDir) {
  const files = {};
  const abs = walkFiles(srcDir);
  if (abs.length === 0) throw new Error('srcDir kosong — tidak ada yang dienkripsi');
  let total = 0;
  for (const full of abs) {
    const buf = fs.readFileSync(full);
    files[relPosix(full, srcDir)] = { b64: buf.toString('base64'), size: buf.length };
    total += buf.length;
  }
  return { magic: `${MAGIC}-INNER`, files, totalFiles: abs.length, totalBytes: total };
}

function encrypt(srcDir, outFile, masterKey) {
  if (!fs.existsSync(srcDir)) throw new Error(`srcDir tidak ada: ${srcDir}`);
  const inner = buildContainer(srcDir);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(inner), 'utf8'));
  // NB: aesDecrypt mengembalikan STRING utf8 (lossy utk biner) — karena itu
  // payload dienkripsi sebagai base64 STRING, bukan Buffer, agar roundtrip
  // lossless tanpa mengubah lib/crypto.js.
  const envelope = aesEncrypt(key32(masterKey), gz.toString('base64'));
  const container = {
    magic: MAGIC,
    kdf: { salt: KDF_SALT, label: KDF_LABEL, iterations: 600000 },
    encryptedAt: new Date().toISOString(),
    innerFiles: inner.totalFiles,
    innerBytes: inner.totalBytes,
    envelope,
  };
  fs.writeFileSync(outFile, JSON.stringify(container));
  return { outFile, files: inner.totalFiles, bytes: inner.totalBytes };
}

function assertSafeRel(rel) {
  if (!rel || typeof rel !== 'string') throw new Error('path tidak valid');
  if (rel.includes('\\')) throw new Error('path backslash ditolak');
  if (rel.startsWith('/') || path.isAbsolute(rel)) throw new Error('path absolut ditolak');
  if (rel.split('/').includes('..')) throw new Error('path traversal ditolak');
}

function decrypt(encFile, outDir, masterKey) {
  const raw = JSON.parse(fs.readFileSync(encFile, 'utf8'));
  if (raw.magic !== MAGIC) throw new Error('bukan container state VM-Panel (magic salah)');
  if (!raw.envelope || !raw.envelope.ct) throw new Error('envelope tidak valid');
  // aesDecrypt → string utf8 berisi base64 (payload dienkripsi sbg base64,
  // lihat encrypt()) → decode ke gzip asli.
  const gzB64 = aesDecrypt(key32(masterKey), raw.envelope); // throw bila key salah/tamper
  const inner = JSON.parse(zlib.gunzipSync(Buffer.from(gzB64, 'base64')).toString('utf8'));
  if (inner.magic !== `${MAGIC}-INNER`) throw new Error('inner magic salah');
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [rel, meta] of Object.entries(inner.files)) {
    assertSafeRel(rel);
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(meta.b64, 'base64'));
    written.push(rel);
  }
  return { outDir, files: written };
}

/* ---------------- CLI ---------------- */

function fail(msg) {
  console.error(`[state-container] ${msg}`);
  process.exit(1);
}

const [, , cmd, a, b, c] = process.argv;
try {
  if (cmd === 'encrypt' && a && b && c) {
    const r = encrypt(a, b, c);
    console.log(`[state-container] encrypted → ${r.outFile} (${r.files} file, ${r.bytes} byte)`);
  } else if (cmd === 'decrypt' && a && b && c) {
    const r = decrypt(a, b, c);
    console.log(`[state-container] decrypted → ${r.outDir} (${r.files.length} file)`);
    console.log(r.files.map((f) => `  ${f}`).join('\n'));
  } else {
    fail(`usage:\n  node scripts/state-container.mjs encrypt <srcDir> <outFile> <masterKey>\n  node scripts/state-container.mjs decrypt <encFile> <outDir> <masterKey>`);
  }
} catch (e) {
  fail(`${e?.message ?? e} (penyebab umum: master key salah, file tampered, atau file bukan container VPSTATE1)`);
}
