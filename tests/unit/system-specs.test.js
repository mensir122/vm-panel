// tests/unit/system-specs.test.js — GET /system/specs end-to-end.
// Manager nyata via start() di sandbox (port acak) — pola api-data-routes.test.js.
// Assert shape (cpu/memory/host + disk nullable), 401 tanpa token, close bersih.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Manager } from '../../manager/index.js';

// 'Connection: close' — socket ditutup per respons, tidak ada koneksi
// keep-alive undici yang tertinggal. Tanpa ini, --test-force-exit (dipakai
// validasi repo) bisa menabrak socket pooled yang sedang ditutup →
// assertion libuv "UV_HANDLE_CLOSING" di Windows.
const H = (t) => ({ Authorization: `Bearer ${t}`, Connection: 'close' });

function randomHighPort() {
  // 20000-29999 — hindari bentrok layanan dev
  return 20000 + Math.floor(Math.random() * 10000);
}

let dir;
let manager;
let base;
let token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vmpanel-syspecs-'));
  for (let attempt = 0; attempt < 5; attempt++) {
    manager = new Manager({
      rootDir: dir,
      config: { manager: { apiPort: randomHighPort(), hostMode: 'dev' } },
      token: 'test-token-specs-0123456789abcdef',
    });
    try {
      await manager.start();
      break;
    } catch (e) {
      if (String(e?.code ?? '') !== 'EADDRINUSE' || attempt === 4) throw e;
    }
  }
  base = `http://127.0.0.1:${manager.api.port}`;
  token = manager.token;
});

after(async () => {
  if (manager && manager.running) await manager.stop();
  rmSync(dir, { recursive: true, force: true });
  // Beri waktu handle libuv (undici/sqlite) menyelesaikan transisi close —
  // --test-force-exit bisa memanggil process.exit saat handle masih
  // UV_HANDLE_CLOSING (race Node-on-Windows) bila suite selesai sangat cepat.
  await delay(250);
});

describe('GET /system/specs', () => {
  test('shape: cpu/memory/host terisi, disk nullable + invarian totalMb >= usedMb >= 0', async () => {
    const r = await fetch(`${base}/system/specs`, { headers: H(token) });
    assert.equal(r.status, 200);
    const b = await r.json();

    // cpu
    assert.ok(b.cpu, 'cpu object ada');
    assert.ok(Number.isInteger(b.cpu.cores) && b.cpu.cores >= 1, 'cpu.cores >= 1');
    assert.equal(typeof b.cpu.model, 'string');
    assert.ok(typeof b.cpu.load1 === 'number' && b.cpu.load1 >= 0, 'cpu.load1 number >= 0');
    assert.ok(
      typeof b.cpu.usagePct === 'number' && b.cpu.usagePct >= 0 && b.cpu.usagePct <= 100,
      'cpu.usagePct clamp 0..100',
    );

    // memory
    assert.ok(b.memory, 'memory object ada');
    assert.ok(Number.isFinite(b.memory.totalMb) && b.memory.totalMb > 0, 'memory.totalMb > 0');
    assert.ok(Number.isInteger(b.memory.usedMb) && b.memory.usedMb >= 0, 'memory.usedMb >= 0');
    assert.ok(Number.isInteger(b.memory.freeMb) && b.memory.freeMb >= 0, 'memory.freeMb >= 0');
    assert.ok(b.memory.usedPct >= 0 && b.memory.usedPct <= 100, 'memory.usedPct 0..100');
    assert.ok(
      b.memory.usedMb + b.memory.freeMb <= b.memory.totalMb + 1,
      'used+free konsisten dengan total (toleransi pembulatan)',
    );

    // disk: boleh null; kalau tidak null harus invarian
    if (b.disk !== null) {
      assert.ok(Number.isInteger(b.disk.totalMb) && b.disk.totalMb > 0, 'disk.totalMb > 0');
      assert.ok(Number.isInteger(b.disk.usedMb) && b.disk.usedMb >= 0, 'disk.usedMb >= 0');
      assert.ok(Number.isInteger(b.disk.freeMb) && b.disk.freeMb >= 0, 'disk.freeMb >= 0');
      assert.ok(b.disk.usedPct >= 0 && b.disk.usedPct <= 100, 'disk.usedPct 0..100');
      assert.ok(b.disk.totalMb >= b.disk.usedMb, 'disk.totalMb >= disk.usedMb');
      assert.ok(b.disk.usedMb >= 0, 'disk.usedMb >= 0');
    }

    // host
    assert.ok(b.host, 'host object ada');
    assert.equal(typeof b.host.platform, 'string');
    assert.ok(b.host.platform.length > 0, 'host.platform terisi');
    assert.ok(b.host.nodeVersion.startsWith('v'), "host.nodeVersion startsWith 'v'");
    assert.ok(typeof b.host.hostname === 'string' && b.host.hostname.length > 0);
    assert.ok(Number.isInteger(b.host.uptimeSec) && b.host.uptimeSec >= 0, 'host.uptimeSec >= 0');
  });

  test('tanpa token → 401', async () => {
    const r = await fetch(`${base}/system/specs`, { headers: { Connection: 'close' } });
    assert.equal(r.status, 401);
    await r.text();
  });

  test('token salah → 401', async () => {
    const r = await fetch(`${base}/system/specs`, { headers: H('token-salah') });
    assert.equal(r.status, 401);
    await r.text();
  });
});
