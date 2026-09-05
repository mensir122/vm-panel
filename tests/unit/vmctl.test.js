// tests/unit/vmctl.test.js — unit test fungsi murni bin/vmctl.js.
// Struktur ekspor: { parseArgv, renderTable, confirmPhrase } (+ main untuk
// pengujian opsional). CLI tidak dieksekusi saat import (main entry guard).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv, renderTable, confirmPhrase, main } from '../../bin/vmctl.js';
import { VmPanelError, isVmPanelError, VALIDATION } from '../../lib/errors.js';

describe('parseArgv', () => {
  test('system status', () => {
    assert.deepEqual(parseArgv(['system', 'status']), {
      noun: 'system', verb: 'status', args: [], flags: {},
    });
  });

  test('project list', () => {
    assert.deepEqual(parseArgv(['project', 'list']), {
      noun: 'project', verb: 'list', args: [], flags: {},
    });
  });

  test('audit list --limit 5', () => {
    const parsed = parseArgv(['audit', 'list', '--limit', '5']);
    assert.equal(parsed.noun, 'audit');
    assert.equal(parsed.verb, 'list');
    assert.deepEqual(parsed.flags, { limit: '5' });
  });

  test('flag --key=value dan boolean --key', () => {
    const a = parseArgv(['audit', 'list', '--limit=7', '--actor']);
    assert.deepEqual(a.flags, { limit: '7', actor: true });
  });

  test('args posisional dipisah dari flag', () => {
    const p = parseArgv(['project', 'remove', 'prj_abc', '--force', 'x']);
    assert.equal(p.noun, 'project');
    assert.equal(p.verb, 'remove');
    assert.deepEqual(p.args, ['prj_abc', 'x']);
    assert.deepEqual(p.flags, { force: true });
  });

  test('unknown noun → throw VALIDATION', () => {
    assert.throws(() => parseArgv(['bogus', 'list']), (e) => isVmPanelError(e) && e.code === VALIDATION);
  });

  test('unknown verb → throw VALIDATION', () => {
    assert.throws(() => parseArgv(['project', 'fly']), (e) => isVmPanelError(e) && e.code === VALIDATION);
  });

  test('noun-only diberi verb → throw VALIDATION', () => {
    assert.throws(() => parseArgv(['health', 'extra']), (e) => isVmPanelError(e) && e.code === VALIDATION);
  });

  test('tanpa noun → throw VALIDATION', () => {
    assert.throws(() => parseArgv([]), (e) => isVmPanelError(e) && e.code === VALIDATION);
    assert.throws(() => parseArgv(['--limit', '5']), (e) => isVmPanelError(e) && e.code === VALIDATION);
  });

  test('error berupa VmPanelError', () => {
    try {
      parseArgv(['nope']);
      assert.fail('must throw');
    } catch (e) {
      assert.ok(e instanceof VmPanelError);
      assert.equal(e.code, VALIDATION);
    }
  });
});

describe('renderTable', () => {
  test('kolom rapi selebar cell terpanjang, terpisah 2 spasi', () => {
    const out = renderTable(
      ['ID', 'NAME'],
      [['prj_1', 'alpha'], ['prj_longer', 'b']],
    );
    const lines = out.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'ID          NAME');
    assert.equal(lines[1], 'prj_1       alpha');
    assert.equal(lines[2], 'prj_longer  b');
  });

  test('header lebih panjang dari isi', () => {
    const out = renderTable(['STATUS'], [['ok']]);
    assert.deepEqual(out.split('\n'), ['STATUS', 'ok']);
  });

  test('tanpa rows → hanya header', () => {
    assert.equal(renderTable(['A', 'B'], []), 'A  B');
  });

  test('nilai non-string & null dikonversi aman', () => {
    const out = renderTable(['N', 'X'], [[5, null]]);
    assert.deepEqual(out.split('\n'), ['N  X', '5']);
  });
});

describe('confirmPhrase (two-phase)', () => {
  test('benar: input persis sama', () => {
    assert.equal(confirmPhrase('prj_abc', 'prj_abc'), true);
  });

  test('benar: whitespace pinggir diabaikan', () => {
    assert.equal(confirmPhrase('prj_abc', '  prj_abc\n'), true);
  });

  test('salah: beda huruf besar/kecil', () => {
    assert.equal(confirmPhrase('prj_abc', 'PRJ_ABC'), false);
  });

  test('salah: beda isi / ekstra karakter', () => {
    assert.equal(confirmPhrase('prj_abc', 'prj_abcd'), false);
    assert.equal(confirmPhrase('prj_abc', ' prj_abc extra'), false);
  });

  test('salah: input null/undefined/bukan string', () => {
    assert.equal(confirmPhrase('prj_abc', null), false);
    assert.equal(confirmPhrase('prj_abc', undefined), false);
    assert.equal(confirmPhrase('prj_abc', 42), false);
  });
});

describe('main() (level proses, tanpa spawn)', () => {
  test('help → exit 0', async () => {
    const code = await main(['help']);
    assert.equal(code, 0);
  });

  test('unknown command → exit 1', async () => {
    const code = await main(['bogus', 'list']);
    assert.equal(code, 1);
  });

  test('command tanpa token → exit 1 dengan pesan auth', async () => {
    // Hermetic: matikan env token DAN arahkan token-file ke path yang pasti
    // tidak ada (di mesin dengan manager berjalan, cli-token nyata ada).
    const prev = {
      VM_PANEL_TOKEN: process.env.VM_PANEL_TOKEN,
      VM_PANEL_TOKEN_FILE: process.env.VM_PANEL_TOKEN_FILE,
    };
    delete process.env.VM_PANEL_TOKEN;
    process.env.VM_PANEL_TOKEN_FILE = 'tests/.tmp-no-token/' + Date.now();
    try {
      const code = await main(['system', 'status']);
      assert.equal(code, 1);
    } finally {
      if (prev.VM_PANEL_TOKEN !== undefined) process.env.VM_PANEL_TOKEN = prev.VM_PANEL_TOKEN;
      else delete process.env.VM_PANEL_TOKEN;
      if (prev.VM_PANEL_TOKEN_FILE !== undefined) process.env.VM_PANEL_TOKEN_FILE = prev.VM_PANEL_TOKEN_FILE;
      else delete process.env.VM_PANEL_TOKEN_FILE;
    }
  });
});
