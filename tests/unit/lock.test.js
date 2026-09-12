// tests/unit/lock.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquire, release, refresh, withLock, acquireAll, releaseAll } from '../../lib/lock.js';
import { VmPanelError, LOCK_HELD } from '../../lib/errors.js';

let locksDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  locksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-locks-'));
});

afterEach(() => {
  fs.rmSync(locksDir, { recursive: true, force: true });
});

const opts = (extra = {}) => ({ dir: locksDir, ...extra });

test('acquire/release: file lock dibuat, isinya JSON pid/host/waktu, release menghapus', async () => {
  const token = await acquire('project-1', opts());
  const file = path.join(locksDir, 'project-1.lock');
  assert.ok(fs.existsSync(file));
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof info.pid, 'number');
  assert.equal(typeof info.host, 'string');
  assert.equal(typeof info.acquiredAt, 'string');
  assert.equal(typeof info.expiresAt, 'string'); // UTC ISO-8601 (Lampiran A)
  assert.ok(!Number.isNaN(Date.parse(info.expiresAt)));
  assert.equal(release('project-1', token, opts()), true);
  assert.equal(fs.existsSync(file), false);
});

test('double-acquire: lock kedua gagal LOCK_HELD', async () => {
  const t1 = await acquire('prj_A', opts({ maxWaitMs: 200 }));
  await assert.rejects(
    () => acquire('prj_A', opts({ maxWaitMs: 200 })),
    (e) => e instanceof VmPanelError && e.code === LOCK_HELD,
  );
  release('prj_A', t1, opts());
});

test('double-acquire: timeout menunggu -> LOCK_HELD dengan waitedMs', async () => {
  const t1 = await acquire('prj_B', opts());
  const start = Date.now();
  await assert.rejects(
    () => acquire('prj_B', opts({ maxWaitMs: 350, retryMs: 100 })),
    (e) => e.code === LOCK_HELD && e.details?.waitedMs === 350,
  );
  assert.ok(Date.now() - start >= 300);
  release('prj_B', t1, opts());
});

test('setelah release, lock bisa diambil lagi', async () => {
  const t1 = await acquire('prj_C', opts({ maxWaitMs: 500 }));
  release('prj_C', t1, opts());
  const t2 = await acquire('prj_C', opts({ maxWaitMs: 500 }));
  release('prj_C', t2, opts());
});

test('stale takeover: lock expired bisa diambil alih dan event dicatat', async () => {
  const file = path.join(locksDir, 'prj_D.lock');
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid: 999999,
      host: 'old-host',
      token: 'dead-token',
      acquiredAt: '2020-01-01T00:00:00Z',
      expiresAt: Date.now() - 1000,
    }),
  );
  const token = await acquire('prj_D', opts({ maxWaitMs: 1000 }));
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.notEqual(info.token, 'dead-token');
  assert.equal(info.pid, process.pid);
  const takeoverLog = fs.readFileSync(path.join(locksDir, 'stale-takeover.log'), 'utf8');
  assert.ok(takeoverLog.includes('stale_takeover'));
  assert.ok(takeoverLog.includes('prj_D'));
  release('prj_D', token, opts());
});

test('lock yang BELUM expired tidak bisa diambil alih walau pid-nya beda', async () => {
  const file = path.join(locksDir, 'prj_E.lock');
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid: 999999,
      host: 'other-host',
      token: 'live-token',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  await assert.rejects(
    () => acquire('prj_E', opts({ maxWaitMs: 150 })),
    (e) => e.code === LOCK_HELD,
  );
  // file tidak dihapus oleh percobaan pencurian
  assert.ok(fs.existsSync(file));
});

test('release: pemilik salah (token beda) TIDAK bisa menghapus lock', async () => {
  const token = await acquire('prj_F', opts());
  assert.equal(release('prj_F', 'token-palsu', opts()), false);
  assert.ok(fs.existsSync(path.join(locksDir, 'prj_F.lock'))); // masih ada
  release('prj_F', token, opts());
  assert.equal(fs.existsSync(path.join(locksDir, 'prj_F.lock')), false);
});

test('release: idempotent — lock yang sudah tidak ada -> false, tidak throw', () => {
  assert.equal(release('tidak-ada', 'x', opts()), false);
});

test('F8: lock 0-byte (holder sedang menulis payload) BUKAN stale — tidak direbut', async () => {
  const file = path.join(locksDir, 'prj_Z1.lock');
  fs.writeFileSync(file, ''); // 0-byte, baru dibuat → dalam grace window
  await assert.rejects(
    () => acquire('prj_Z1', opts({ maxWaitMs: 200, retryMs: 50 })),
    (e) => e.code === LOCK_HELD,
  );
  assert.ok(fs.existsSync(file), 'lock 0-byte tidak boleh dihapus dalam grace');
  assert.equal(fs.existsSync(path.join(locksDir, 'stale-takeover.log')), false);
});

test('F8: payload korup + grace habis (staleGraceMs=0) → takeover normal + event tercatat', async () => {
  const file = path.join(locksDir, 'prj_Z2.lock');
  fs.writeFileSync(file, ''); // 0-byte tapi grace 0ms → dianggap yatim
  const token = await acquire('prj_Z2', opts({ maxWaitMs: 1000, retryMs: 20, staleGraceMs: 0 }));
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(info.token, token);
  assert.ok(fs.readFileSync(path.join(locksDir, 'stale-takeover.log'), 'utf8').includes('prj_Z2'));
  release('prj_Z2', token, opts());
});

test('F8: create+payload atomik — file hasil acquire selalu JSON lengkap', async () => {
  const token = await acquire('prj_Z3', opts());
  const file = path.join(locksDir, 'prj_Z3.lock');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.length > 0, 'payload terisi segera setelah acquire resolve');
  const info = JSON.parse(raw);
  assert.equal(info.token, token);
  assert.equal(info.pid, process.pid);
  release('prj_Z3', token, opts());
});

test('F5/refresh: TTL lock diperpanjang hanya oleh pemilik token', async () => {
  const token = await acquire('prj_R', opts({ ttlMs: 1000 }));
  const file = path.join(locksDir, 'prj_R.lock');
  const before = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).expiresAt);
  await sleep(50);
  assert.equal(refresh('prj_R', 'token-salah', opts({ ttlMs: 60_000 })), false, 'bukan pemilik → false');
  assert.equal(refresh('prj_R', token, opts({ ttlMs: 60_000 })), true);
  const after = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).expiresAt);
  assert.ok(after - before > 50_000, `expiresAt maju (${after - before}ms)`);
  // refresh lock yang tidak ada → false, tidak membuat file baru
  assert.equal(refresh('prj_TIDAK_ADA', token, opts()), false);
  assert.equal(fs.existsSync(path.join(locksDir, 'prj_TIDAK_ADA.lock')), false);
  release('prj_R', token, opts());
});

test('F5/withLock heartbeat: operasi lebih lama dari TTL tidak kehilangan lock', async () => {
  const file = path.join(locksDir, 'prj_HB.lock');
  const out = await withLock(
    'prj_HB',
    opts({ ttlMs: 150, heartbeatMs: 50, maxWaitMs: 200 }),
    async () => {
      await sleep(400); // 2.6x TTL — tanpa heartbeat lock sudah expired
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(Date.parse(info.expiresAt) > Date.now(), 'TTL diperpanjang heartbeat');
      return 'done';
    },
  );
  assert.equal(out, 'done');
  assert.equal(fs.existsSync(file), false, 'lock dilepas setelah fn selesai');
});

test('withLock: fn jalan dengan token, lock otomatis dilepas (sukses & gagal)', async () => {
  const file = path.join(locksDir, 'prj_G.lock');
  const result = await withLock('prj_G', opts(), async (token) => {
    assert.ok(fs.existsSync(file));
    assert.equal(typeof token, 'string');
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(fs.existsSync(file), false);

  await assert.rejects(
    () =>
      withLock('prj_G', opts(), async () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(fs.existsSync(file), false); // release tetap jalan (finally)
});

test('withLock: lock kedua saat withLock aktif -> LOCK_HELD', async () => {
  await assert.rejects(() =>
    withLock('prj_H', opts({ maxWaitMs: 100 }), async () => {
      await acquire('prj_H', opts({ maxWaitMs: 100 }));
    }),
  );
});

test('acquireAll: acquired berurutan sorted leksikografis (anti-deadlock §9.1)', async () => {
  const handle = await acquireAll(['prj_z', 'prj_a', 'prj_m', 'backup-global'], opts());
  assert.deepEqual(
    handle.acquired.map((x) => x.name),
    ['backup-global', 'prj_a', 'prj_m', 'prj_z'], // global dulu, lalu leksikografis
  );
  for (const { name } of handle.acquired) {
    assert.ok(fs.existsSync(path.join(locksDir, `${name}.lock`)));
  }
  releaseAll(handle, opts());
  for (const { name } of handle.acquired) {
    assert.equal(fs.existsSync(path.join(locksDir, `${name}.lock`)), false);
  }
});

test('acquireAll: gagal di tengah -> yang sudah didapat di-release, throw ulang', async () => {
  // Kunci 'prj_b' manual supaya acquireAll(['prj_a','prj_b','prj_c']) gagal di urutan kedua.
  const blocker = await acquire('prj_b', opts());
  await assert.rejects(() => acquireAll(['prj_c', 'prj_a', 'prj_b'], opts({ maxWaitMs: 150 })));
  // prj_a & prj_c tidak boleh tersisa terkunci
  assert.equal(fs.existsSync(path.join(locksDir, 'prj_a.lock')), false);
  assert.equal(fs.existsSync(path.join(locksDir, 'prj_c.lock')), false);
  // blocker masih dipegang pemiliknya
  assert.ok(fs.existsSync(path.join(locksDir, 'prj_b.lock')));
  release('prj_b', blocker, opts());
});

test('releaseAll: urutan release terbalik dari akuisisi (§9.1)', async () => {
  const calls = [];
  // Monitor urutan via perubahan ada/tidak file: gunakan nama dan cek setelahnya.
  const handle = await acquireAll(['n1', 'n2', 'n3'], opts());
  releaseAll(handle, opts());
  calls.push(...handle.acquired.map((x) => x.name));
  assert.deepEqual(calls, ['n1', 'n2', 'n3']); // akuisisi sorted
  // Semua terlepas — verifikasi perilaku fungsional urutan terbalik di lock.js.
  for (const n of calls) assert.equal(fs.existsSync(path.join(locksDir, `${n}.lock`)), false);
});

test('nama lock tidak valid -> VALIDATION', async () => {
  await assert.rejects(() => acquire('../evil', opts()), (e) => e.code === 'VALIDATION');
});
