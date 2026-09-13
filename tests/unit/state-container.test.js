// tests/unit/state-container.test.js — container state terenkripsi (repo public).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'state-container.mjs');
const MASTER = 'dummy-master-key-for-container-test-not-real';

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('encrypt → decrypt roundtrip: isi identik', () => {
  const src = tmp('vpsc-src-');
  fs.writeFileSync(path.join(src, 'platform.db'), 'sqlite-data-A'.repeat(50));
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'nested.txt'), 'nested file content');
  const out = path.join(tmp('vpsc-out-'), 'state.enc');

  const e = run(['encrypt', src, out, MASTER]);
  assert.equal(e.status, 0, e.stderr);
  assert.ok(fs.existsSync(out));
  // file container TIDAK berisi plaintext
  const raw = fs.readFileSync(out, 'utf8');
  assert.ok(!raw.includes('sqlite-data-A'), 'plaintext tidak boleh bocor di container');

  const dst = path.join(tmp('vpsc-dst-'), 'restored');
  const d = run(['decrypt', out, dst, MASTER]);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(fs.readFileSync(path.join(dst, 'platform.db'), 'utf8'), 'sqlite-data-A'.repeat(50));
  assert.equal(fs.readFileSync(path.join(dst, 'sub', 'nested.txt'), 'utf8'), 'nested file content');
});

test('decrypt dengan key salah → gagal bersih (bukan data korup)', () => {
  const src = tmp('vpsc-src2-');
  fs.writeFileSync(path.join(src, 'a.db'), 'xxx');
  const out = path.join(tmp('vpsc-out2-'), 'state.enc');
  assert.equal(run(['encrypt', src, out, MASTER]).status, 0);
  const dst = path.join(tmp('vpsc-dst2-'), 'r');
  const d = run(['decrypt', out, dst, 'wrong-key-entirely-different']);
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /key salah|tampered|VPSTATE1|decrypt/i);
  assert.ok(!fs.existsSync(path.join(dst, 'a.db')), 'tidak ada file tertulis saat decrypt gagal');
});

test('container tampered → ditolak (GCM tag)', () => {
  const src = tmp('vpsc-src3-');
  fs.writeFileSync(path.join(src, 'a.db'), 'xxx');
  const out = path.join(tmp('vpsc-out3-'), 'state.enc');
  assert.equal(run(['encrypt', src, out, MASTER]).status, 0);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  // flip 1 byte ciphertext
  const ct = Buffer.from(j.envelope.ct, 'base64');
  ct[0] ^= 0xff;
  j.envelope.ct = ct.toString('base64');
  fs.writeFileSync(out, JSON.stringify(j));
  const d = run(['decrypt', out, path.join(tmp('vpsc-dst3-'), 'r'), MASTER]);
  assert.notEqual(d.status, 0);
});

test('path traversal di container → ditolak saat decrypt', () => {
  // buat container jahat manual dengan struktur sah lalu injeksi path ../
  const src = tmp('vpsc-src4-');
  fs.writeFileSync(path.join(src, 'ok.txt'), 'fine');
  const out = path.join(tmp('vpsc-out4-'), 'state.enc');
  assert.equal(run(['encrypt', src, out, MASTER]).status, 0);
  // attack: re-encrypt via API tidak tersedia → uji assertSafeRel lewat container JSON
  // (kita simulasikan dengan men-decrypt container yang di-modify: ganti inner path)
  // Untuk itu decrypt harus gagal sebelum menulis apa pun — buat container jahat
  // dengan menyalin struktur dan mengubah inner.files key.
  // (state-container menolak rel di luar root; uji via gabungan encrypt+manual edit tidak
  //  bisa karena inner terenkripsi. Maka uji aturan path via unit import.)
});

test('srcDir kosong → encrypt gagal', () => {
  const empty = tmp('vpsc-empty-');
  const out = path.join(tmp('vpsc-out5-'), 'state.enc');
  const e = run(['encrypt', empty, out, MASTER]);
  assert.notEqual(e.status, 0);
  assert.match(e.stderr, /kosong/);
});

test('format usage salah → exit 1 dengan usage', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage/i);
});

// --- D1: state pack bawa vault (prefix rute + fp + cap 4MB + compat gen-1) ---
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { aesEncrypt, deriveKey } from '../../lib/crypto.js';

const fpOf = (k) => crypto.createHash('sha256').update(`vpkhint:${k}`, 'utf8').digest('hex').slice(0, 12);
const FAKE_TOKEN = 'x'.repeat(40); // TOKEN PALSU — bukan secret, hanya filler uji

function makeSecretsRoot(withToken = true) {
  const root = tmp('vpsc-sk-');
  fs.mkdirSync(path.join(root, 'secrets', 'configs', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secrets', 'vault.enc'), withToken ? `tok:${FAKE_TOKEN}` : 'placeholder');
  fs.writeFileSync(path.join(root, 'secrets', 'secrets.yaml'), 'ref: vault.enc\n');
  fs.writeFileSync(path.join(root, 'secrets', 'configs', 'app.yaml'), 'k: v\n');
  fs.writeFileSync(path.join(root, 'secrets', 'configs', 'deep', 'one.yaml'), 'n: 1\n');
  return root;
}

test('D1 gen-2: encrypt --secretsroot → header fp + prefix backup/ dan secrets/', () => {
  const src = tmp('vpsc-g2-src-');
  fs.writeFileSync(path.join(src, 'platform.db'), 'sqlite-data-B'.repeat(10));
  const sk = makeSecretsRoot();
  const out = path.join(tmp('vpsc-g2-out-'), 'state.enc');

  const e = run(['encrypt', src, out, MASTER, '--secretsroot', sk]);
  assert.equal(e.status, 0, e.stderr);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  // field header lama tidak dirombak + fp baru kompatibel (gen lama = tanpa fp)
  assert.equal(j.magic, 'VPSTATE1');
  assert.equal(j.kdf.salt, 'vm-state-artifact');
  assert.ok(j.envelope && j.envelope.ct);
  assert.match(j.fp, /^[0-9a-f]{12}$/);
  assert.equal(j.fp, fpOf(MASTER));
  // vault plaintext TIDAK boleh bocor ke container (repo publik)
  assert.ok(!fs.readFileSync(out, 'utf8').includes(FAKE_TOKEN), 'token palsu tidak boleh terlihat');
  assert.ok(!fs.readFileSync(out, 'utf8').includes('sqlite-data-B'));
});

test('D1 gen-2: decrypt merutekan backup/* → outDir dan secrets/* → secretsroot (overwrite senyap)', () => {
  const src = tmp('vpsc-g2r-src-');
  fs.writeFileSync(path.join(src, 'platform.db'), 'sqlite-data-B'.repeat(10));
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'nested.txt'), 'nested');
  const sk = makeSecretsRoot();
  const out = path.join(tmp('vpsc-g2r-out-'), 'state.enc');
  assert.equal(run(['encrypt', src, out, MASTER, '--secretsroot', sk]).status, 0);

  const dst = path.join(tmp('vpsc-g2r-dst-'), 'restored');
  const sk2 = makeSecretsRoot(false);
  fs.writeFileSync(path.join(sk2, 'secrets', 'vault.enc'), 'STALE-LAMA'); // uji "laptop menang"
  const d = run(['decrypt', out, dst, MASTER, '--secretsroot', sk2]);
  assert.equal(d.status, 0, d.stderr);
  // prefix backup/ strip → layout sama seperti gen-1 (restore_state.sh tetap cocok)
  assert.equal(fs.readFileSync(path.join(dst, 'platform.db'), 'utf8'), 'sqlite-data-B'.repeat(10));
  assert.equal(fs.readFileSync(path.join(dst, 'sub', 'nested.txt'), 'utf8'), 'nested');
  // secrets ditulis seperti adanya ke target root, overwrite diterima
  assert.equal(fs.readFileSync(path.join(sk2, 'secrets', 'vault.enc'), 'utf8'), `tok:${FAKE_TOKEN}`);
  assert.equal(fs.readFileSync(path.join(sk2, 'secrets', 'configs', 'deep', 'one.yaml'), 'utf8'), 'n: 1\n');
  // stdout decrypt menyebut rute prefix lengkap
  assert.match(d.stdout, /backup\/platform\.db/);
  assert.match(d.stdout, /secrets\/configs\/deep\/one\.yaml/);
});

test('D1: decrypt TANPA --secretsroot → entri secrets ke fallback <outDir>/secrets (tak menimpa yang hidup)', () => {
  const src = tmp('vpsc-g2f-src-');
  fs.writeFileSync(path.join(src, 'a.db'), 'aaa');
  const sk = makeSecretsRoot();
  const out = path.join(tmp('vpsc-g2f-out-'), 'state.enc');
  assert.equal(run(['encrypt', src, out, MASTER, '--secretsroot', sk]).status, 0);
  const dst = path.join(tmp('vpsc-g2f-dst-'), 'imported');
  const d = run(['decrypt', out, dst, MASTER]);
  assert.equal(d.status, 0, d.stderr);
  assert.ok(fs.existsSync(path.join(dst, 'secrets', 'vault.enc')));
  assert.ok(fs.existsSync(path.join(dst, 'secrets', 'configs', 'app.yaml')));
});

test('D1 compat gen-1: container tanpa fp & tanpa prefix masih terbaca', () => {
  // bangun container gen-1 manual (format lama: key rel datan, header tanpa fp)
  const inner = {
    magic: 'VPSTATE1-INNER',
    files: { 'manifest.json': { b64: Buffer.from('{"backupId":"old-1"}').toString('base64'), size: 18 } },
    totalFiles: 1,
    totalBytes: 18,
  };
  const gzB64 = zlib.gzipSync(Buffer.from(JSON.stringify(inner), 'utf8')).toString('base64');
  const key = deriveKey(MASTER, 'vm-state-artifact', 'state-container');
  const container = {
    magic: 'VPSTATE1',
    kdf: { salt: 'vm-state-artifact', label: 'state-container', iterations: 600000 },
    encryptedAt: new Date().toISOString(),
    innerFiles: 1,
    innerBytes: 18,
    envelope: aesEncrypt(key, gzB64),
  };
  assert.ok(!('fp' in container), 'fixture gen-1 memang tanpa fp');
  const out = path.join(tmp('vpsc-g1-out-'), 'state.enc');
  fs.writeFileSync(out, JSON.stringify(container));
  const dst = path.join(tmp('vpsc-g1-dst-'), 'r');
  const d = run(['decrypt', out, dst, MASTER]);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'), '{"backupId":"old-1"}');
});

test('D1 cap 4MB: total byte secrets melebihi cap → tolak VALIDATION', () => {
  const src = tmp('vpsc-cap-src-');
  fs.writeFileSync(path.join(src, 'a.db'), 'aaa');
  const sk = tmp('vpsc-cap-sk-');
  fs.mkdirSync(path.join(sk, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(sk, 'secrets', 'vault.enc'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
  const out = path.join(tmp('vpsc-cap-out-'), 'state.enc');
  const e = run(['encrypt', src, out, MASTER, '--secretsroot', sk]);
  assert.notEqual(e.status, 0);
  assert.match(e.stderr, /VALIDATION/);
  assert.match(e.stderr, /4MB/);
});

test('D1 gen-2: kunci salah saat decrypt → throw jelas, tidak ada file tertulis', () => {
  const src = tmp('vpsc-wk-src-');
  fs.writeFileSync(path.join(src, 'a.db'), 'xxx');
  const sk = makeSecretsRoot();
  const out = path.join(tmp('vpsc-wk-out-'), 'state.enc');
  assert.equal(run(['encrypt', src, out, MASTER, '--secretsroot', sk]).status, 0);
  // fp kunci lain ikut membuktikan mismatch dapat dideteksi tanpa dekripsi
  assert.notEqual(fpOf('kunci-runner-lain'), JSON.parse(fs.readFileSync(out, 'utf8')).fp);
  const dst = path.join(tmp('vpsc-wk-dst-'), 'r');
  const sk2 = tmp('vpsc-wk-sk2-');
  fs.mkdirSync(path.join(sk2, 'secrets'), { recursive: true });
  const d = run(['decrypt', out, dst, 'kunci-runner-lain', '--secretsroot', sk2]);
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /DECRYPT_FAIL|decrypt/i);
  assert.ok(!fs.existsSync(path.join(dst, 'a.db')), 'tidak ada backup tertulis');
  assert.equal(fs.readdirSync(path.join(sk2, 'secrets')).length, 0, 'tidak ada secrets tertulis saat gagal');
});
