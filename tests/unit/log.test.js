// tests/unit/log.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../../lib/log.js';
import { makeRedactor } from '../../lib/redact.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-log-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readLines(name) {
  const raw = fs.readFileSync(path.join(dir, `${name}.log`), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

test('entry: satu baris JSON valid dengan ts UTC ISO-8601, level, name, msg', () => {
  const log = createLogger({ dir, name: 'app' });
  log.info('halo dunia');
  const [entry] = readLines('app');
  assert.equal(entry.level, 'info');
  assert.equal(entry.name, 'app');
  assert.equal(entry.msg, 'halo dunia');
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // UTC ISO
  assert.equal(new Date(entry.ts).toISOString(), entry.ts);
});

test('semua level menulis file sesuai namanya', () => {
  const log = createLogger({ dir, name: 'lvl', level: 'debug' });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e', { code: 'X' });
  const lines = readLines('lvl');
  assert.deepEqual(lines.map((l) => l.level), ['debug', 'info', 'warn', 'error']);
  assert.equal(lines[3].code, 'X');
});

test('level filter: default info menyembunyikan debug', () => {
  const log = createLogger({ dir, name: 'filtered' });
  log.debug('sembunyi');
  log.info('tampil');
  const lines = readLines('filtered');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'tampil');
});

test('redaction masuk log: token di msg dan extra ikut tereduksi', () => {
  const log = createLogger({ dir, name: 'sec' });
  log.info('login token: abc123', { headers: 'authorization: Basic dXNlcjpwYXNz' });
  const [entry] = readLines('sec');
  assert.equal(entry.msg, 'login token: ***REDACTED***');
  assert.equal(entry.headers, 'authorization: ***REDACTED***');
  assert.ok(!JSON.stringify(entry).includes('abc123'));
  assert.ok(!JSON.stringify(entry).includes('dXNlcjpwYXNz'));
});

test('redactor kustom (extraValues) dipakai logger', () => {
  const rd = makeRedactor({ extraValues: new Set(['sv-nilai-rahasia-777']) });
  const log = createLogger({ dir, name: 'custom', redactor: rd });
  log.warn('akses pakai sv-nilai-rahasia-777');
  const [entry] = readLines('custom');
  assert.equal(entry.msg, 'akses pakai ***REDACTED***');
});

test('child: fields induk + child digabung, child menimpa induk', () => {
  const base = createLogger({ dir, name: 'child', fields: { component: 'manager', region: 'id' } });
  const c1 = base.child({ requestId: 'req_1' });
  const c2 = c1.child({ requestId: 'req_2', component: 'worker' });
  base.info('dari induk');
  c1.info('dari c1');
  c2.info('dari c2', { attempt: 3 });
  const lines = readLines('child');
  assert.equal(lines[0].component, 'manager');
  assert.equal(lines[1].component, 'manager');
  assert.equal(lines[1].requestId, 'req_1');
  assert.equal(lines[2].requestId, 'req_2');
  assert.equal(lines[2].component, 'worker'); // child menimpa induk
  assert.equal(lines[2].attempt, 3);
  // semua ke file yang sama
  assert.equal(lines.length, 3);
});

test('extra tidak menimpa field inti (ts/level/name/msg)', () => {
  const log = createLogger({ dir, name: 'core' });
  log.info('pesan', { ts: 'FAKE', level: 'FAKE', name: 'FAKE', msg: 'FAKE', ok: 1 });
  const [entry] = readLines('core');
  assert.equal(entry.level, 'info');
  assert.equal(entry.name, 'core');
  assert.equal(entry.msg, 'pesan');
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(entry.ok, 1);
});

test('multi-baris: tiap entry satu baris JSON (newline-delimited)', () => {
  const log = createLogger({ dir, name: 'ndjson' });
  log.info('satu');
  log.info('dua', { n: 2 });
  log.error('tiga');
  const raw = fs.readFileSync(path.join(dir, 'ndjson.log'), 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 3);
  for (const l of lines) assert.equal(typeof JSON.parse(l).ts, 'string');
});

test('tulis file gagal -> stderr, tidak throw', (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const log = createLogger({ dir, name: 'ok' });
  // Hapus dir setelah logger dibuat -> appendFileSync gagal (ENOENT).
  fs.rmSync(dir, { recursive: true, force: true });
  assert.doesNotThrow(() => log.info('tetap jalan'));
  assert.ok(process.stderr.write.mock.callCount() > 0);
});
