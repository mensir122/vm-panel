#!/usr/bin/env node
// scripts/state-container.mjs — container state TERENKRIPSI untuk artifact
// GitHub Actions (repo public → artifact bisa diunduh siapa saja → WAJIB
// terenkripsi sebelum upload).
//
// Format file .enc (JSON):
//   { magic: 'VPSTATE1', kdf: {salt, iterations}, fp, envelope: {iv, tag, ct} }
//   envelope = AES-256-GCM atas gzip(JSON {files: {routepath: base64}})
// Kunci = PBKDF2-SHA256(masterKey, salt, 600k) 32 byte (AES-256-GCM).
//
// Gen-2 (D1): entri inner memakai PREFIX rute:
//   'backup/<relpath>'          — isi srcDir
//   'secrets/vault.enc', 'secrets/secrets.yaml', 'secrets/configs/**'
//                               — dari <secretsroot>/secrets/ (cap 4MB total)
// Header plaintext baru: fp = sha256hex('vpkhint:'+masterKey).slice(0,12)
// (guard fingerprint kunci di restore_state.sh — tanpa membaca isi terenkripsi).
// Kompat gen-1: container tanpa fp = legacy; entri tanpa prefix diperlakukan
// sebagai 'backup/<rel>' saat decrypt.
//
// Pemakaian:
//   node scripts/state-container.mjs encrypt <srcDir> <outFile> <masterKey> [--secretsroot <root>]
//   node scripts/state-container.mjs decrypt <encFile> <outDir> <masterKey> [--secretsroot <root>]
// decrypt tanpa --secretsroot: entri 'secrets/*' ditulis ke <outDir>/secrets/
// (fallback netral — tidak menimpa secrets hidup).
//
// Desain: docs/DESIGN.md §9.5 (anti-destruktif), §13 (kripto), §15 (artifact).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { aesEncrypt, aesDecrypt, deriveKey } from '../lib/crypto.js';

const MAGIC = 'VPSTATE1';
const KDF_SALT = 'vm-state-artifact';
const KDF_LABEL = 'state-container';
const BACKUP_PREFIX = 'backup/';
const SECRETS_PREFIX = 'secrets/';
const SECRETS_CAP_BYTES = 4 * 1024 * 1024; // cap protektif total byte secrets

function key32(masterKey) {
  // deriveKey(secret, salt, label) — PBKDF2 600k di dalam lib/crypto.js.
  return deriveKey(String(masterKey), KDF_SALT, KDF_LABEL);
}

/** Fingerprint plaintext-master-key utk guard VPKEY_MISMATCH (12 hex char). */
function keyFingerprint(masterKey) {
  return crypto
    .createHash('sha256')
    .update(`vpkhint:${String(masterKey)}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
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

function buildContainer(srcDir, secretsRoot = null) {
  const files = {};
  const abs = walkFiles(srcDir);
  if (abs.length === 0) throw new Error('srcDir kosong — tidak ada yang dienkripsi');
  let total = 0;
  for (const full of abs) {
    const buf = fs.readFileSync(full);
    files[BACKUP_PREFIX + relPosix(full, srcDir)] = { b64: buf.toString('base64'), size: buf.length };
    total += buf.length;
  }
  // --- secrets masuk pack (D1): hanya file yang ada; cap 4MB total ---
  let secretsBytes = 0;
  if (secretsRoot) {
    const sroot = path.join(secretsRoot, 'secrets');
    const addSecret = (routeKey, full) => {
      const buf = fs.readFileSync(full);
      secretsBytes += buf.length;
      if (secretsBytes > SECRETS_CAP_BYTES) {
        throw new Error(
          `VALIDATION: total byte secrets melebihi cap ${SECRETS_CAP_BYTES} byte (4MB) — tolak pack (route: ${routeKey})`,
        );
      }
      files[routeKey] = { b64: buf.toString('base64'), size: buf.length };
      total += buf.length;
    };
    for (const name of ['vault.enc', 'secrets.yaml']) {
      const p = path.join(sroot, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) addSecret(SECRETS_PREFIX + name, p);
    }
    const cfgDir = path.join(sroot, 'configs');
    if (fs.existsSync(cfgDir) && fs.statSync(cfgDir).isDirectory()) {
      for (const full of walkFiles(cfgDir)) {
        addSecret(`${SECRETS_PREFIX}configs/${relPosix(full, cfgDir)}`, full);
      }
    }
  }
  return { magic: `${MAGIC}-INNER`, files, totalFiles: Object.keys(files).length, totalBytes: total };
}

function encrypt(srcDir, outFile, masterKey, secretsRoot = null) {
  if (!fs.existsSync(srcDir)) throw new Error(`srcDir tidak ada: ${srcDir}`);
  const inner = buildContainer(srcDir, secretsRoot);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(inner), 'utf8'));
  // NB: aesDecrypt mengembalikan STRING utf8 (lossy utk biner) — karena itu
  // payload dienkripsi sebagai base64 STRING, bukan Buffer, agar roundtrip
  // lossless tanpa mengubah lib/crypto.js.
  const envelope = aesEncrypt(key32(masterKey), gz.toString('base64'));
  const container = {
    magic: MAGIC,
    kdf: { salt: KDF_SALT, label: KDF_LABEL, iterations: 600000 },
    encryptedAt: new Date().toISOString(),
    // fp = fingerprint plaintext utk guard kunci (restore_state.sh) SEBELUM
    // dekripsi. Bukan secret: sha256 satu arah atas prefix + kunci.
    fp: keyFingerprint(masterKey),
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

function decrypt(encFile, outDir, masterKey, secretsRoot = null) {
  const raw = JSON.parse(fs.readFileSync(encFile, 'utf8'));
  if (raw.magic !== MAGIC) throw new Error('bukan container state VM-Panel (magic salah)');
  if (!raw.envelope || !raw.envelope.ct) throw new Error('envelope tidak valid');
  // aesDecrypt → string utf8 berisi base64 (payload dienkripsi sbg base64,
  // lihat encrypt()) → decode ke gzip asli. Kunci salah/tamper → THROW DI SINI
  // sebelum satu byte pun ditulis (DECRYPT_FAIL dari lib/crypto.js).
  const gzB64 = aesDecrypt(key32(masterKey), raw.envelope);
  const inner = JSON.parse(zlib.gunzipSync(Buffer.from(gzB64, 'base64')).toString('utf8'));
  if (inner.magic !== `${MAGIC}-INNER`) throw new Error('inner magic salah');
  // Target secrets: --secretsroot → <root>/secrets/ (overwrite senyap =
  // "laptop menang" by design). Tanpa root → fallback netral <outDir>/secrets/
  // (tidak pernah menimpa secrets hidup tanpa diminta).
  const secretsBase = secretsRoot ? path.join(secretsRoot, 'secrets') : path.join(outDir, 'secrets');
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [rel, meta] of Object.entries(inner.files)) {
    assertSafeRel(rel);
    let dest;
    if (rel.startsWith(SECRETS_PREFIX)) {
      // 'secrets/<x>' → tulis seperti adanya di bawah target secrets root.
      dest = path.join(secretsBase, rel.slice(SECRETS_PREFIX.length));
    } else {
      // Gen-2 'backup/<x>' dan gen-1 legacy tanpa prefix → sama: ke target
      // backup dengan layout relatif asli (prefix strip).
      const relBackup = rel.startsWith(BACKUP_PREFIX) ? rel.slice(BACKUP_PREFIX.length) : rel;
      if (!relBackup) throw new Error(`entri backup kosong tidak sah: ${rel}`);
      dest = path.join(outDir, relBackup);
    }
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

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--secretsroot') {
      const v = argv[++i];
      if (!v) throw new Error('--secretsroot butuh nilai direktori root');
      opts.secretsRoot = v;
    } else {
      pos.push(argv[i]);
    }
  }
  return { pos, opts };
}

const USAGE =
  'usage:\n' +
  '  node scripts/state-container.mjs encrypt <srcDir> <outFile> <masterKey> [--secretsroot <root>]\n' +
  '  node scripts/state-container.mjs decrypt <encFile> <outDir> <masterKey> [--secretsroot <root>]';

try {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const [cmd, a, b, c] = pos;
  if (cmd === 'encrypt' && a && b && c) {
    const r = encrypt(a, b, c, opts.secretsRoot ?? null);
    console.log(`[state-container] encrypted → ${r.outFile} (${r.files} file, ${r.bytes} byte)`);
  } else if (cmd === 'decrypt' && a && b && c) {
    const r = decrypt(a, b, c, opts.secretsRoot ?? null);
    console.log(`[state-container] decrypted → ${r.outDir} (${r.files.length} file)`);
    console.log(r.files.map((f) => `  ${f}`).join('\n'));
  } else {
    fail(USAGE);
  }
} catch (e) {
  fail(`${e?.message ?? e} (penyebab umum: master key salah, file tampered, atau file bukan container VPSTATE1)`);
}
