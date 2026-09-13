// tests/unit/service-manager-env-refs.test.js — D3 materialisasi env-secret
// saat start service (regression per sub-item):
//  (a) ref resolve → env child memuat nilai (spawn stub, assert env injection)
//  (b) ref hilang → VALIDATION & TIDAK spawn + audit jelas
//  (c) nilai TIDAK muncul di log/audit (assert fp + tidak-substring) & terdaftar
//      ke redactor SHARED (addExtraValues)
//  (d) user tanpa secretManager → perilaku identik lama (no-op, spawn normal)
//  (e) listProjectEnv kosong → tanpa perubahan + vault tak tersentuh
//
// Terisolasi: ProcessManager & adapter di-stub; SecretManager = fake berbasis
// kontrak nyata (listProjectEnv / listSecrets / getSecretValue). Tidak ada
// proses nyata, tidak ada port nyata.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { ServiceManager } from '../../manager/service_manager/index.js';
import { makeRedactor, REDACTED_VALUE } from '../../lib/redact.js';
import { VmPanelError, VALIDATION } from '../../lib/errors.js';
import { genId } from '../../lib/ids.js';

const EXPECTED_PORT = 20999;

// ── stub ProcessManager: menangkap argumen startProcess, tanpa spawn nyata ────
function makeFakeProcessManager() {
  const calls = [];
  return {
    calls,
    assertPortLegal(port) {
      return port;
    },
    async portBindTest() {
      return true;
    },
    startProcess(opts) {
      calls.push(opts);
      return { pid: 424242, startTimeHint: null, droppedKeys: [] };
    },
    async stopProcess() {
      return { stopped: true, exitCode: 'killed' };
    },
    async isAlive() {
      return false;
    },
    listProcesses() {
      return [];
    },
  };
}

// ── adapter registry stub: startSpec deterministik, env dasar non-rahasia ─────
function makeFakeAdapters(baseEnv) {
  class FakeAdapter {
    constructor() {}
    startSpec() {
      return { argv: ['fake-cmd', 'run'], cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-envcwd-')), env: { ...baseEnv }, port: EXPECTED_PORT };
    }
    healthCheckSpec() {
      return { type: 'process' };
    }
  }
  return { fake: FakeAdapter };
}

// ── logger & audit capture (kumpul baris utuh untuk assert substring) ─────────
function makeCaptureLogger() {
  const lines = [];
  const rec = (level) => (msg, extra) => lines.push({ level, msg, extra, raw: JSON.stringify({ msg, extra }) });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}
function makeCaptureAudit() {
  const events = [];
  return { events, append: (e) => events.push(e) };
}

// ── SecretManager fake sesuai kontrak produksi ────────────────────────────────
//   listProjectEnv(projectId) → [{ envName, secretName }]
//   listSecrets()             → [{ name, projectScope }]  (metadata, tanpa nilai)
//   getSecretValue(name,{projectScope}) → string | throw
function makeFakeSecretManager({ refs = [], secrets = [], values = {}, spies = {} }) {
  return {
    listProjectEnv(projectId) {
      spies.listProjectEnv = (spies.listProjectEnv || 0) + 1;
      return refs.map((r) => ({ ...r }));
    },
    listSecrets() {
      spies.listSecrets = (spies.listSecrets || 0) + 1;
      if (spies.throwOnListSecrets) throw new Error('brankas belum diinisialisasi');
      return secrets.map((s) => ({ ...s }));
    },
    getSecretValue(name, { projectScope } = {}) {
      spies.getSecretValue = (spies.getSecretValue || 0) + 1;
      const key = `${name}::${projectScope == null ? 'null' : String(projectScope)}`;
      if (key in values) return values[key];
      const err = new Error(`secret not found: ${name}`);
      err.code = 'SECRET_NOT_FOUND';
      throw err;
    },
  };
}

// ── harness: ServiceManager terisolasi + satu service siap-start ──────────────
const cleanup = [];
test.after(() => {
  for (const c of cleanup) {
    try { c.svcMgr.close(); } catch { /* noop */ }
    try { fs.rmSync(c.sandbox, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function setup({ secretManager = null, redactor = null, baseEnv = { PORT: String(EXPECTED_PORT) } } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-env-'));
  const dataDir = path.join(sandbox, 'data');
  const procMgr = makeFakeProcessManager();
  const logger = makeCaptureLogger();
  const audit = makeCaptureAudit();
  const svcMgr = new ServiceManager({
    dataDir,
    processManager: procMgr,
    adapters: makeFakeAdapters(baseEnv),
    auditManager: audit,
    logger,
    secretManager,
    redactor: redactor ?? null,
  });
  const projectId = genId('prj_');
  const svc = svcMgr.createService({ projectId, name: 'env-svc', type: 'fake', port: EXPECTED_PORT });
  const handle = { sandbox, svcMgr, procMgr, logger, audit, projectId, svc };
  cleanup.push(handle);
  return handle;
}

function codeIs(code) {
  return (e) => e instanceof VmPanelError && e.code === code;
}
function fpOf(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

// ── (a) resolve → nilai masuk ke env child; env non-rahasia dipertahankan ─────
test('(a) env-secret ter-resolve masuk ke env spawn; env dasar tak berubah', async () => {
  const SECRET = 'TG-B0T-T0K3N-sup3r-s3kr3t';
  const sm = makeFakeSecretManager({
    refs: [{ envName: 'BOT_TOKEN', secretName: 'tg_bot_token' }],
    secrets: [{ name: 'tg_bot_token', projectScope: null }],
    values: { 'tg_bot_token::null': SECRET },
  });
  const redactor = makeRedactor();
  const h = setup({ secretManager: sm, redactor });

  const started = await h.svcMgr.startService(h.svc.id);
  assert.ok(started.pid > 0, 'start sukses');

  assert.equal(h.procMgr.calls.length, 1, 'spawn dipanggil sekali');
  const env = h.procMgr.calls[0].env;
  assert.equal(env.BOT_TOKEN, SECRET, 'nilai secret diinjeksikan ke child env');
  assert.equal(env.PORT, String(EXPECTED_PORT), 'env dasar (non-rahasia) dipertahankan');
  assert.deepEqual(h.procMgr.calls[0].extraEnv, {}, 'extraEnv tetap {} (hierarki lama utuh)');

  // (c sebagian) nilai terdaftar ke redactor SHARED → tereduksi di mana pun.
  assert.equal(redactor.hasExtraValue(SECRET), true, 'nilai didaftarkan ke redactor');
  assert.ok(redactor(`x ${SECRET} y`).includes(REDACTED_VALUE), 'redactor memotong nilai mentah');
});

// resolved MENANG atas env mentah dengan nama sama (hierarki rahasia di puncak)
test('(a2) resolved menang atas env mentah dengan nama kunci sama', async () => {
  const SECRET = 'resolved-wins-value';
  const sm = makeFakeSecretManager({
    refs: [{ envName: 'PORT', secretName: 'override' }],
    secrets: [{ name: 'override', projectScope: 'scope-a' }],
    values: { 'override::scope-a': SECRET },
  });
  const h = setup({ secretManager: sm, baseEnv: { PORT: 'raw-should-lose' } });
  await h.svcMgr.startService(h.svc.id);
  assert.equal(h.procMgr.calls[0].env.PORT, SECRET, 'resolved menimpa env mentah');
});

// ── (b) ref hilang → VALIDATION + TIDAK spawn + audit jelas ───────────────────
test('(b) secret_ref tak resolve → VALIDATION, tidak spawn, audit env_resolve_failed', async () => {
  const sm = makeFakeSecretManager({
    refs: [{ envName: 'BOT_TOKEN', secretName: 'gone' }],
    secrets: [], // 'gone' tidak ada di vault → unresolvable
    values: {},
  });
  const h = setup({ secretManager: sm });

  await assert.rejects(() => h.svcMgr.startService(h.svc.id), (e) => {
    assert.ok(codeIs(VALIDATION)(e), 'harus VALIDATION');
    assert.match(e.message, /secret_ref tidak resolve: BOT_TOKEN/, 'pesan menyebut envName');
    return true;
  });

  assert.equal(h.procMgr.calls.length, 0, 'DILARANG spawn tanpa token');
  assert.equal(h.svcMgr.getService(h.svc.id).status, 'stopped', 'status tidak berubah ke running');

  const failed = h.audit.events.filter((e) => e.operation === 'startService.env_resolve_failed');
  assert.equal(failed.length, 1, 'audit kegagalan tercatat');
  assert.equal(failed[0].input.envName, 'BOT_TOKEN');
});

// vault absent (listSecrets throw) dengan ref ada → VALIDATION, tak spawn
test('(b2) vault absent saat ada ref → VALIDATION, tidak spawn', async () => {
  const sm = makeFakeSecretManager({
    refs: [{ envName: 'API_KEY', secretName: 'x' }],
    secrets: [],
    values: {},
    spies: { throwOnListSecrets: true },
  });
  const h = setup({ secretManager: sm });
  await assert.rejects(() => h.svcMgr.startService(h.svc.id), codeIs(VALIDATION));
  assert.equal(h.procMgr.calls.length, 0, 'tidak spawn saat vault tak bisa dibaca');
});

// nilai kosong bukan token sah → VALIDATION
test('(b3) nilai secret kosong → VALIDATION (start tanpa token dilarang)', async () => {
  const sm = makeFakeSecretManager({
    refs: [{ envName: 'BOT_TOKEN', secretName: 'empty' }],
    secrets: [{ name: 'empty', projectScope: null }],
    values: { 'empty::null': '' },
  });
  const h = setup({ secretManager: sm });
  await assert.rejects(() => h.svcMgr.startService(h.svc.id), codeIs(VALIDATION));
  assert.equal(h.procMgr.calls.length, 0);
});

// ── (c) log/audit tidak memuat nilai; hanya fp 8-hex ─────────────────────────
test('(c) nilai tak muncul di log/audit; service.env_resolved memuat fp', async () => {
  const SECRET = 'V3RY-SECRET-LEAK-CHECK-9f3a';
  const sm = makeFakeSecretManager({
    refs: [{ envName: 'BOT_TOKEN', secretName: 'tg' }],
    secrets: [{ name: 'tg', projectScope: 'prj_scope' }],
    values: { 'tg::prj_scope': SECRET },
  });
  const redactor = makeRedactor();
  const h = setup({ secretManager: sm, redactor });
  await h.svcMgr.startService(h.svc.id);

  // Ada baris info service.env_resolved dengan name + fp, TANPA nilai.
  const resolvedLines = h.logger.lines.filter((l) => l.msg === 'service.env_resolved');
  assert.equal(resolvedLines.length, 1);
  assert.equal(resolvedLines[0].extra.name, 'BOT_TOKEN');
  assert.equal(resolvedLines[0].extra.fp, fpOf(SECRET), 'fp = sha256(nilai)[:8]');
  assert.equal(resolvedLines[0].extra.value, undefined, 'field nilai tidak ada');

  // Tidak ADA satu pun baris log mentah yang mengandung nilai secret.
  for (const l of h.logger.lines) {
    assert.ok(!l.raw.includes(SECRET), `baris log membocorkan nilai: ${l.msg}`);
  }
  // Tidak ADA event audit yang mengandung nilai secret.
  for (const e of h.audit.events) {
    assert.ok(!JSON.stringify(e).includes(SECRET), 'audit membocorkan nilai secret');
  }
  // nilai tetap terdaftar di redactor SHARED (proteksi jalur lain).
  assert.equal(redactor.hasExtraValue(SECRET), true);
});

// ── (d) tanpa secretManager → identik lama (no-op, spawn normal) ──────────────
test('(d) tanpa secretManager diinjeksi → perilaku identik lama', async () => {
  const h = setup({ secretManager: null });
  const started = await h.svcMgr.startService(h.svc.id);
  assert.ok(started.pid > 0);
  assert.equal(h.procMgr.calls.length, 1, 'spawn tetap terjadi seperti semula');
  assert.deepEqual(h.procMgr.calls[0].env, { PORT: String(EXPECTED_PORT) }, 'env persis spec dasar');
});

// ── (e) listProjectEnv kosong → tanpa perubahan & vault tak tersentuh ─────────
test('(e) listProjectEnv kosong → env utuh, vault TIDAK dibaca', async () => {
  const spies = {};
  const sm = makeFakeSecretManager({ refs: [], secrets: [], values: {}, spies });
  const h = setup({ secretManager: sm });
  const started = await h.svcMgr.startService(h.svc.id);
  assert.ok(started.pid > 0);
  assert.deepEqual(h.procMgr.calls[0].env, { PORT: String(EXPECTED_PORT) });
  assert.equal(spies.listProjectEnv, 1, 'listProjectEnv dipanggil');
  assert.equal(spies.listSecrets, undefined, 'listSecrets TIDAK dipanggil (early return)');
  assert.equal(spies.getSecretValue, undefined, 'getSecretValue TIDAK dipanggil');
});

// ── lintasan dua-fase/tidak relevan: start ulang idempoten, nilai tak bocor ke
//    record service (getService / response API). ───────────────────────────────
test('(f) record service tidak memuat nilai (getService bersih, start ulang aman)', async () => {
  const SECRET = 'NO-LEAK-IN-RESPONSE-1234';
  const sm = makeFakeSecretManager({
    refs: [{ envName: 'BOT_TOKEN', secretName: 'tg' }],
    secrets: [{ name: 'tg', projectScope: null }],
    values: { 'tg::null': SECRET },
  });
  const h = setup({ secretManager: sm, redactor: makeRedactor() });

  const first = await h.svcMgr.startService(h.svc.id);
  const rec = h.svcMgr.getService(h.svc.id);
  assert.ok(!JSON.stringify(rec).includes(SECRET), 'getService (→ /services/:id) tak memuat nilai');
  assert.ok(!JSON.stringify(first).includes(SECRET), 'result startService tak memuat nilai');
  assert.equal(h.procMgr.calls.length, 1);

  // start ulang saat running → VALIDATION 'bad state' (bukan soal env), idempoten.
  await assert.rejects(() => h.svcMgr.startService(h.svc.id), (e) => codeIs(VALIDATION)(e));
  assert.equal(h.procMgr.calls.length, 1, 'tidak spawn ganda');
});
