// tests/unit/config.test.js — lib/config.js: parse config.yaml asli project,
// env override, default fallback (node:test, offline).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseValue, parseYamlSimple, DEFAULTS } from '../../lib/config.js';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const tmpRoot = join(tmpdir(), 'vmpanel-config-test');
mkdirSync(tmpRoot, { recursive: true });
let dir;

// Simpan env asli — dipulihkan setelah tiap test.
const ENV_KEYS = ['VPANEL_ROOT', 'MANAGER_API_PORT', 'PANEL_PORT', 'VM_PANEL_ENV'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpRoot, 'run-'));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('parseYamlSimple / parseValue — unit parser', () => {
  test('parseValue: int, float, bool, null, quoted, plain, list', () => {
    assert.equal(parseValue('42'), 42);
    assert.equal(parseValue('-7'), -7);
    assert.equal(parseValue('3.5'), 3.5);
    assert.equal(parseValue('true'), true);
    assert.equal(parseValue('false'), false);
    assert.equal(parseValue('null'), null);
    assert.equal(parseValue('~'), null);
    assert.equal(parseValue('"dev"'), 'dev');
    assert.equal(parseValue("'actions'"), 'actions');
    assert.equal(parseValue('off'), 'off');
    assert.deepEqual(parseValue('[5, 15, 30]'), [5, 15, 30]);
    assert.deepEqual(parseValue('["a", "b c", d]'), ['a', 'b c', 'd']);
  });

  test('nested 2-level + komentar + inline comment', () => {
    const obj = parseYamlSimple(`
# full line comment
manager:
  api_port: 8097      # inline comment
  host_mode: "dev"
ports:
  range: [10000, 65535]
  reserved: [22, 80, 443]
`);
    assert.deepEqual(obj, {
      manager: { apiPort: 8097, hostMode: 'dev' },
      ports: { range: [10000, 65535], reserved: [22, 80, 443] },
    });
  });

  test('nested 3-level (backup.retention.latest) + hash di nilai quoted', () => {
    const obj = parseYamlSimple(`
backup:
  interval_hours: 6
  retention:
    latest: 3
    daily: 7
    weekly: 4
tunnel:
  provider: "none"
`);
    assert.equal(obj.backup.intervalHours, 6);
    assert.deepEqual(obj.backup.retention, { latest: 3, daily: 7, weekly: 4 });
    assert.equal(obj.tunnel.provider, 'none');
  });

  test('block kosong (key: tanpa anak) → null', () => {
    const obj = parseYamlSimple('foo:\nbar: 1\n');
    assert.equal(obj.foo, null);
    assert.equal(obj.bar, 1);
  });

  test('snake_case → camelCase (api_port → apiPort, max_backup_size_mb → maxBackupSizeMb)', () => {
    const obj = parseYamlSimple('storage:\n  max_backup_size_mb: 2048\n');
    assert.equal(obj.storage.maxBackupSizeMb, 2048);
  });
});

describe('loadConfig — config.yaml asli project (repo root)', () => {
  test('nilai kunci sesuai isi config.yaml project', () => {
    // rootDir repo asli — file config.yaml project ada di sana.
    const cfg = loadConfig({ rootDir: PROJECT_ROOT });
    assert.equal(cfg.manager.apiPort, 8097);
    assert.equal(cfg.manager.hostMode, 'dev');
    assert.deepEqual(cfg.ports.range, [10000, 65535]);
    assert.deepEqual(cfg.ports.reserved, [22, 80, 443, 8080, 8097]);
    assert.deepEqual(cfg.supervisor.backoffSeq, [5, 15, 30, 60, 120]);
    assert.equal(cfg.supervisor.maxRestarts, 5);
    assert.equal(cfg.supervisor.stableWindowSec, 600);
    assert.equal(cfg.supervisor.pollIntervalSec, 5);
    assert.equal(cfg.health.defaultIntervalSec, 30);
    assert.equal(cfg.backup.intervalHours, 6);
    assert.deepEqual(cfg.backup.retention, { latest: 3, daily: 7, weekly: 4 });
    assert.equal(cfg.storage.warnPct, 20);
    assert.equal(cfg.storage.critPct, 10);
    assert.equal(cfg.storage.maxBackupSizeMb, 2048);
    assert.equal(cfg.panel.port, 8080);
    assert.equal(cfg.panel.sessionTtlMin, 480);
    assert.equal(cfg.worker.pool, 4);
    assert.equal(cfg.worker.queueCap, 32);
    assert.equal(cfg.runner.mode, 'off');
    assert.equal(cfg.runner.jobMinutesBudget, 300);
    assert.equal(cfg.runner.drainMinutes, 15);
    assert.equal(cfg.tunnel.provider, 'none');
  });
});

describe('loadConfig — sandbox tmp (config.yaml buatan)', () => {
  test('fallback default untuk key yang hilang', () => {
    writeFileSync(join(dir, 'config.yaml'), 'manager:\n  api_port: 9999\n');
    const cfg = loadConfig({ rootDir: dir });
    assert.equal(cfg.manager.apiPort, 9999);
    // sisanya default
    assert.equal(cfg.manager.hostMode, DEFAULTS.manager.hostMode);
    assert.deepEqual(cfg.ports.range, DEFAULTS.ports.range);
    assert.deepEqual(cfg.supervisor.backoffSeq, DEFAULTS.supervisor.backoffSeq);
    assert.equal(cfg.panel.port, DEFAULTS.panel.port);
  });

  test('file config.yaml tidak ada → semua default, tidak throw', () => {
    const cfg = loadConfig({ rootDir: dir });
    assert.equal(cfg.manager.apiPort, DEFAULTS.manager.apiPort);
    assert.deepEqual(cfg.ports.reserved, DEFAULTS.ports.reserved);
  });

  test('DEFAULTS frozen — loadConfig tidak memutasinya', () => {
    const before = JSON.stringify(DEFAULTS);
    writeFileSync(join(dir, 'config.yaml'), 'panel:\n  port: 3000\n');
    const cfg1 = loadConfig({ rootDir: dir });
    cfg1.manager.apiPort = 1;
    assert.equal(JSON.stringify(DEFAULTS), before);
    const cfg2 = loadConfig({ rootDir: dir });
    assert.equal(cfg2.panel.port, 3000);
    assert.equal(cfg2.manager.apiPort, DEFAULTS.manager.apiPort);
    assert.throws(() => {
      'use strict';
      DEFAULTS.manager.apiPort = 1234;
    });
  });

  test('VPANEL_ROOT env menentukan root bila rootDir tidak diberikan', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.yaml'), 'worker:\n  pool: 7\n');
    process.env.VPANEL_ROOT = dir;
    const cfg = loadConfig();
    assert.equal(cfg.worker.pool, 7);
    assert.equal(cfg.rootDir, dir);
  });
});

describe('loadConfig — env override', () => {
  test('MANAGER_API_PORT menimpa manager.apiPort', () => {
    writeFileSync(join(dir, 'config.yaml'), 'manager:\n  api_port: 9999\n');
    process.env.MANAGER_API_PORT = '8123';
    const cfg = loadConfig({ rootDir: dir });
    assert.equal(cfg.manager.apiPort, 8123);
  });

  test('PANEL_PORT menimpa panel.port', () => {
    process.env.PANEL_PORT = '9090';
    const cfg = loadConfig({ rootDir: dir });
    assert.equal(cfg.panel.port, 9090);
  });

  test('VM_PANEL_ENV menimpa cfg.env', () => {
    process.env.VM_PANEL_ENV = 'actions';
    const cfg = loadConfig({ rootDir: dir });
    assert.equal(cfg.env, 'actions');
  });

  test('env non-integer diabaikan (fallback tetap dipakai)', () => {
    process.env.MANAGER_API_PORT = 'not-a-port';
    const cfg = loadConfig({ rootDir: dir });
    assert.equal(cfg.manager.apiPort, DEFAULTS.manager.apiPort);
  });

  test('VPANEL_ROOT env string kosong dianggap unset — rootDir argumen tetap dipakai', () => {
    process.env.VPANEL_ROOT = '';
    const cfg = loadConfig({ rootDir: dir });
    assert.equal(cfg.rootDir, dir); // rootDir argumen menang atas env
  });
});
