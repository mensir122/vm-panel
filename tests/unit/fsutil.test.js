// tests/unit/fsutil.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile, atomicWriteJson, readJson, ensureDir } from '../../lib/fsutil.js';
import { VmPanelError, NOT_FOUND } from '../../lib/errors.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-fsutil-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureDir: idempotent, nested dibuat', () => {
  const nested = path.join(dir, 'a', 'b', 'c');
  ensureDir(nested);
  ensureDir(nested); // panggil lagi — tidak error
  assert.ok(fs.statSync(nested).isDirectory());
});

test('atomicWriteFile: tulis data benar & tidak menyisakan tmp', () => {
  const f = path.join(dir, 'out.txt');
  atomicWriteFile(f, 'isi penting');
  assert.equal(fs.readFileSync(f, 'utf8'), 'isi penting');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('atomicWriteFile: rename menimpa existing file', () => {
  const f = path.join(dir, 'out.txt');
  fs.writeFileSync(f, 'lama');
  atomicWriteFile(f, 'baru');
  assert.equal(fs.readFileSync(f, 'utf8'), 'baru');
});

test('atomicWriteFile: menulis ke direktori yang sama (tmp tidak pindah volume)', () => {
  const f = path.join(dir, 'sub', 'x.json');
  atomicWriteFile(f, '{}');
  assert.ok(fs.statSync(path.join(dir, 'sub')).isDirectory());
});

test('atomicWriteFile: buffer binary utuh', () => {
  const f = path.join(dir, 'bin.dat');
  const buf = Buffer.from([0, 1, 2, 255, 254, 0]);
  atomicWriteFile(f, buf);
  assert.deepEqual(fs.readFileSync(f), buf);
});

test('atomicWriteJson + readJson: round-trip object', () => {
  const f = path.join(dir, 'data.json');
  const obj = { name: 'svc-1', tags: ['a', 'b'], nested: { n: 3 } };
  atomicWriteJson(f, obj);
  assert.deepEqual(readJson(f), obj);
  // valid JSON (bukan dua baris JSON concatenated)
  const raw = fs.readFileSync(f, 'utf8');
  assert.equal(JSON.parse(raw).name, 'svc-1');
});

test('readJson: file tidak ada -> VmPanelError NOT_FOUND', () => {
  assert.throws(() => readJson(path.join(dir, 'missing.json')), (e) => e instanceof VmPanelError && e.code === NOT_FOUND);
});

test('readJson: JSON invalid -> SyntaxError', () => {
  const f = path.join(dir, 'bad.json');
  fs.writeFileSync(f, '{not json');
  assert.throws(() => readJson(f), SyntaxError);
});
