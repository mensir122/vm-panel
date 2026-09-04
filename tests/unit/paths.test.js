// tests/unit/paths.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeJoin, assertInside, walkChecked } from '../../lib/paths.js';
import { VmPanelError, PATH_ESCAPE } from '../../lib/errors.js';

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-paths-'));
  fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'sub', 'deep', 'a.txt'), 'a');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('safeJoin: gabungan normal di dalam root', () => {
  const p = safeJoin(root, 'sub', 'deep', 'a.txt');
  assert.equal(p, path.join(fs.realpathSync(root), 'sub', 'deep', 'a.txt'));
});

test('safeJoin: tolak part absolut (POSIX, drive, UNC)', () => {
  assert.throws(() => safeJoin(root, '/etc/passwd'), (e) => e instanceof VmPanelError && e.code === PATH_ESCAPE);
  if (process.platform === 'win32') {
    assert.throws(() => safeJoin(root, 'C:\\Windows\\evil'), (e) => e.code === PATH_ESCAPE);
    assert.throws(() => safeJoin(root, '\\\\server\\share'), (e) => e.code === PATH_ESCAPE);
  }
});

test("safeJoin: tolak '..' di mana pun posisinya", () => {
  assert.throws(() => safeJoin(root, '..'), (e) => e.code === PATH_ESCAPE);
  assert.throws(() => safeJoin(root, 'sub', '..', 'secret.txt'), (e) => e.code === PATH_ESCAPE);
  assert.throws(() => safeJoin(root, 'sub/deep/../../x'), (e) => e.code === PATH_ESCAPE);
});

test('safeJoin: hasil wajib di dalam root (realpath prefix existing)', () => {
  // Simulasi root yang sendiri mengandung symlink: arahkan lewat assertInside saja;
  // untuk safeJoin cukup pastikan path existing ter-resolve fisik.
  const p = safeJoin(root, 'sub', 'deep', 'newfile.txt'); // file belum ada -> digabung setelah realpath parent
  assert.ok(p.startsWith(fs.realpathSync(root)));
});

test('assertInside: lolos untuk path di dalam root, throw untuk luar', () => {
  const ok = assertInside(root, path.join(root, 'sub', 'file.txt'));
  assert.ok(ok.startsWith(fs.realpathSync(root)));
  assert.throws(() => assertInside(root, os.tmpdir()), (e) => e.code === PATH_ESCAPE);
  if (process.platform === 'win32') {
    assert.throws(() => assertInside(root, 'C:\\Windows'), (e) => e.code === PATH_ESCAPE);
  }
  // absolute path keluar root lewat traversal di argumen langsung:
  assert.throws(
    () => assertInside(root, path.join(root, 'sub', '..', '..', 'evilsibling')),
    (e) => e.code === PATH_ESCAPE,
  );
});

test('walkChecked: enumerasi relatif sorted, symlink dalam root diizinkan', () => {
  fs.symlinkSync(path.join(root, 'sub', 'deep'), path.join(root, 'sub', 'link-internal'), 'junction');
  const list = walkChecked(root);
  assert.ok(list.includes('sub/file.txt'));
  assert.ok(list.includes('sub/deep/a.txt'));
  assert.ok(list.includes('sub/link-internal'));
  // sorted
  const sorted = [...list].sort();
  assert.deepEqual(list, sorted);
});

test('walkChecked: symlink keluar root -> throw PATH_ESCAPE', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    if (process.platform === 'win32') {
      fs.symlinkSync(outside, path.join(root, 'sub', 'link-escape'), 'junction');
    } else {
      fs.symlinkSync(outside, path.join(root, 'sub', 'link-escape'));
    }
    assert.throws(() => walkChecked(root), (e) => e instanceof VmPanelError && e.code === PATH_ESCAPE);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('walkChecked: root kosong -> daftar kosong', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-empty-'));
  try {
    assert.deepEqual(walkChecked(empty), []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
