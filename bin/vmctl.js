#!/usr/bin/env node
// bin/vmctl.js — CLI entrypoint vmctl (docs/DESIGN.md §1.1, §2.3, Lampiran A).
// Parser argv bawaan (tanpa dependency). Command ber-backend F1: system
// status|info, health, project list, audit list. Sisanya stub → pesan
// "not implemented yet (F2/F3)" exit code 2. Verb destruktif
// (remove/archive/restore/purge/rollback/import) = two-phase confirm.
//
// Exit codes: 0 ok, 1 error/aborted, 2 not implemented (F2/F3).

import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { ManagerClient, DEFAULT_PORT } from '../lib/api-client.js';
import { VmPanelError, isVmPanelError, VALIDATION } from '../lib/errors.js';

/** Verb destruktif yang WAJIB two-phase confirm (docs/DESIGN.md §1.1, §10.2). */
const DESTRUCTIVE_VERBS = new Set(['remove', 'archive', 'restore', 'purge', 'rollback', 'import']);

/** Tabel command: noun → Set verb; null = noun-only (tanpa verb). */
const COMMANDS = Object.freeze({
  system: new Set(['status', 'info']),
  project: new Set(['list', 'show', 'deploy', 'start', 'stop', 'restart', 'status', 'logs', 'remove', 'archive', 'restore']),
  service: new Set(['list', 'show', 'status', 'logs', 'start', 'stop', 'restart', 'health', 'enable', 'disable', 'remove', 'archive', 'restore']),
  deployment: new Set(['list', 'show', 'logs', 'retry', 'rollback']),
  backup: new Set(['list', 'show', 'create', 'restore', 'purge']),
  export: new Set(['project', 'all']),
  import: new Set(['project', 'all']),
  audit: new Set(['list']),
  recovery: new Set(['status']),
  health: null,
  help: null,
});

const HELP = [
  'vmctl - VM-Panel CLI (docs/DESIGN.md)',
  '',
  'Usage: vmctl <noun> <verb> [args] [--flag value]',
  '',
  'Commands:',
  '  system status|info                        Manager system status/info',
  '  health                                    Health check (prints OK/FAIL)',
  '  project list                              List projects',
  '  project create --name N --type T [--port P]  Create project (F4)',
  '  project deploy <id>                       Deploy project (workspace) (F4)',
  '  project show|status|logs <id>             (F2)',
  '  project start|stop|restart <id>           (F2)',
  '  project remove|archive|restore <id>       (F2; destructive)',
  '  service list                              List services (F4)',
  '  service show|status <id>                  Service detail (F4)',
  '  service health <id>                       Run health check (F4)',
  '  service start|stop|restart <id>           Service lifecycle (F4)',
  '  service logs <id>                         (F2)',
  '  service enable|disable <id>               (F2)',
  '  service remove|archive|restore <id>       (F2; destructive)',
  '  deployment list [--project ID] [--status S] [--limit N]   (F4)',
  '  deployment show <id>                      Deployment detail + events (F4)',
  '  deployment logs|retry|rollback <id>       (F3; rollback destructive)',
  '  backup list [--limit N]                   List backups (F4)',
  '  backup create                             Create manual backup (F4)',
  '  backup show|restore|purge                 (F3; restore/purge destructive)',
  '  export project <id> | all                 (F3)',
  '  import project <archive> | all <archive>  (F3; destructive)',
  '  audit list [--limit N] [--offset N] [--actor A] [--operation OP] [--project ID]',
  '  recovery status                           Supervisor/recovery rows (F4)',
  '  help                                      Show this help',
  '',
  'Options:',
  '  --token <token>   Override auth token',
  '  --port <port>     Override manager API port (default ' + DEFAULT_PORT + ')',
  '',
  'Token resolution: --token flag > VM_PANEL_TOKEN env > runtime/sockets/cli-token.',
  'Destructive verbs (remove/archive/restore/purge/rollback/import) require',
  'two-phase confirmation: type the target ID exactly to proceed.',
  'Exit codes: 0 ok, 1 error/aborted, 2 not implemented yet (F2/F3).',
  '',
  'Examples:',
  '  vmctl system status',
  '  vmctl health',
  '  vmctl project list',
  '  vmctl audit list --limit 5',
].join('\n');

/** Flag yang mengambil nilai; flag lain = boolean (mencegah menelan arg posisional). */
const VALUE_FLAGS = new Set(['token', 'port', 'limit', 'offset', 'actor', 'operation', 'project', 'name', 'type', 'status']);

/**
 * Parser argv minimal: `vmctl <noun> <verb> [args...] [--flag value]`.
 * Flag forms: --key value (hanya VALUE_FLAGS) | --key=value | --key (boolean true).
 * Validasi terhadap tabel COMMANDS; unknown → VmPanelError(VALIDATION).
 * @param {string[]} argv argv tanpa node + script path (process.argv.slice(2))
 * @returns {{noun: string, verb: string|null, args: string[], flags: Record<string, string|boolean>}}
 * @throws {VmPanelError} code VALIDATION bila command tidak dikenal/ tidak lengkap.
 */
export function parseArgv(argv) {
  const flags = {};
  const positional = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = String(list[i]);
    if (tok.startsWith('--')) {
      let key = tok.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (VALUE_FLAGS.has(key) && i + 1 < list.length && !String(list[i + 1]).startsWith('--')) {
        value = String(list[++i]);
      } else {
        value = true;
      }
      flags[key] = value;
    } else {
      positional.push(tok);
    }
  }

  const [noun, verb, ...args] = positional;
  if (!noun) {
    throw new VmPanelError(VALIDATION, 'missing command (try: vmctl help)');
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, noun)) {
    throw new VmPanelError(VALIDATION, `unknown command: ${noun} (try: vmctl help)`);
  }
  const verbs = COMMANDS[noun];
  if (verbs === null) {
    if (verb) throw new VmPanelError(VALIDATION, `command ${noun} takes no verb (try: vmctl help)`);
    return { noun, verb: null, args: [], flags };
  }
  if (!verb) {
    throw new VmPanelError(VALIDATION, `missing verb for ${noun} (try: vmctl help)`);
  }
  if (!verbs.has(verb)) {
    throw new VmPanelError(VALIDATION, `unknown verb: ${noun} ${verb} (try: vmctl help)`);
  }
  return { noun, verb, args, flags };
}

/**
 * Render tabel monospace rapi: setiap kolom selebar cell terpanjang,
 * dipisah 2 spasi, trailing whitespace dipangkas.
 * @param {string[]} headers
 * @param {Array<Array<*>>} rows
 * @returns {string}
 */
export function renderTable(headers, rows) {
  const head = headers.map((h) => String(h));
  const body = (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r ?? '')]));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').replace(/\s+$/, '');
  return [line(head), ...body.map(line)].join('\n');
}

/**
 * Cek phrase konfirmasi two-phase: HANYA persis cocok (case-sensitive;
 * whitespace di pinggir input diabaikan karena tak terlihat saat mengetik).
 * @param {string} expected phrase yang wajib diketik (mis. project id)
 * @param {unknown} input jawaban user
 * @returns {boolean}
 */
export function confirmPhrase(expected, input) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  return input.trim() === expected;
}

/** Baca token dari runtime/sockets/cli-token (dibuat manager). Absen → undefined. */
function readTokenFile() {
  try {
    const raw = readFileSync(new URL('../runtime/sockets/cli-token', import.meta.url), 'utf8');
    const tok = raw.trim();
    return tok ? tok : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolusi auth: flag --token/--port > env VM_PANEL_TOKEN/MANAGER_API_PORT >
 * file runtime/sockets/cli-token. Token TIDAK PERNAH ditampilkan/log.
 */
function resolveAuth(flags = {}) {
  let token = typeof flags.token === 'string' && flags.token ? flags.token : undefined;
  if (!token && process.env.VM_PANEL_TOKEN) token = process.env.VM_PANEL_TOKEN;
  if (!token) token = readTokenFile();
  if (!token) {
    throw new VmPanelError(VALIDATION, 'no auth token (set VM_PANEL_TOKEN atau start manager)');
  }
  let port = DEFAULT_PORT;
  const rawPort = typeof flags.port === 'string' && flags.port ? flags.port : process.env.MANAGER_API_PORT;
  if (rawPort) {
    const p = Number(rawPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new VmPanelError(VALIDATION, `port invalid: ${rawPort}`);
    }
    port = p;
  }
  return { token, port };
}

function makeClient(flags) {
  const { token, port } = resolveAuth(flags);
  return new ManagerClient({ port, token });
}

function isDestructive(parsed) {
  return parsed.noun === 'import' || DESTRUCTIVE_VERBS.has(parsed.verb);
}

function stdout(text) {
  process.stdout.write(text + '\n');
}

function printError(err) {
  if (isVmPanelError(err)) {
    process.stderr.write(`[${err.code}] ${err.message}\n`);
  } else {
    process.stderr.write(`error: ${err && err.message ? err.message : String(err)}\n`);
  }
}

function fmtUptime(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function labelLine(label, value, width = 11) {
  return `${label.padEnd(width)}: ${value ?? '-'}`;
}

function parseNonNegInt(value, flagName) {
  if (value === undefined || value === true) {
    throw new VmPanelError(VALIDATION, `missing value for ${flagName}`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new VmPanelError(VALIDATION, `${flagName} must be a non-negative integer (got: ${value})`);
  }
  return n;
}

/**
 * Baca satu baris dari stdin. EOF/error/tidak ada input → null.
 * Dipakai two-phase confirm; tanpa dependency readline interactive.
 */
function readLineOnce(stdin = process.stdin) {
  return new Promise((resolve) => {
    if (stdin.readableEnded || stdin.destroyed) {
      resolve(null);
      return;
    }
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        done();
        resolve(buf.slice(0, nl).replace(/\r$/, ''));
      }
    };
    const onEnd = () => {
      done();
      resolve(null);
    };
    const onError = () => {
      done();
      resolve(null);
    };
    function done() {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
    }
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
  });
}

/**
 * Two-phase confirm interaktif (docs/DESIGN.md §10.2 langkah 9-10):
 * tampilkan ringkasan target → prompt "Type to confirm: <phrase>" →
 * lanjut HANYA bila jawaban persis cocok (confirmPhrase).
 * @param {string[]} summaryLines baris ringkasan (ditulis ke stderr)
 * @param {string} phrase yang wajib diketik (mis. project id)
 * @returns {Promise<boolean>} true = user mengonfirmasi persis.
 */
async function confirmTwoPhase(summaryLines, phrase) {
  process.stderr.write(summaryLines.join('\n') + '\n');
  process.stderr.write(`Type to confirm: ${phrase}\n`);
  const answer = await readLineOnce();
  return confirmPhrase(phrase, answer);
}

async function cmdSystem(parsed) {
  const client = makeClient(parsed.flags);
  if (parsed.verb === 'status') {
    const s = await client.systemStatus();
    stdout(
      [
        labelLine('Status', s.status),
        labelLine('Uptime', fmtUptime(s.uptimeSec)),
        labelLine('PID', s.pid),
        labelLine('Host mode', s.hostMode),
        labelLine('Runner ID', s.runnerId),
        labelLine('Started', s.startedAt ? `${s.startedAt} (UTC)` : '-'),
        labelLine('Version', s.version),
      ].join('\n'),
    );
    return 0;
  }
  // verb === 'info'
  const info = await client.systemInfo();
  stdout(
    [
      labelLine('Name', info.name),
      labelLine('Version', info.version),
      labelLine('Data dir', info.dataDir),
    ].join('\n'),
  );
  return 0;
}

async function cmdHealth(parsed) {
  const client = makeClient(parsed.flags);
  const res = await client.health();
  if (res && res.ok === true) {
    stdout('health: OK');
    return 0;
  }
  stdout('health: FAIL');
  return 1;
}

async function cmdProjectList(parsed) {
  const client = makeClient(parsed.flags);
  const projects = await client.listProjects();
  if (!Array.isArray(projects) || projects.length === 0) {
    stdout('(no projects)');
    return 0;
  }
  const rows = projects.map((p) => [
    p.id ?? p.project_id ?? '',
    p.name ?? '',
    p.type ?? '',
    p.status ?? '',
  ]);
  stdout(renderTable(['ID', 'NAME', 'TYPE', 'STATUS'], rows));
  return 0;
}

async function cmdAuditList(parsed) {
  const f = parsed.flags;
  const query = {};
  if (f.limit !== undefined && f.limit !== true) query.limit = parseNonNegInt(f.limit, '--limit');
  if (f.offset !== undefined && f.offset !== true) query.offset = parseNonNegInt(f.offset, '--offset');
  if (typeof f.actor === 'string') query.actor = f.actor;
  if (typeof f.operation === 'string') query.operation = f.operation;
  if (typeof f.project === 'string') query.projectId = f.project;
  const client = makeClient(parsed.flags);
  const res = await client.listAudit(query);
  const rowsRaw = Array.isArray(res && res.rows) ? res.rows : [];
  if (rowsRaw.length === 0) {
    stdout('(no audit events)');
    return 0;
  }
  const rows = rowsRaw.map((r) => [
    r.at ?? r.created_at ?? '',
    r.actor ?? '',
    r.operation ?? '',
    r.project_id ?? r.projectId ?? '',
    r.result ?? '',
  ]);
  stdout(renderTable(['Time', 'Actor', 'Operation', 'Project', 'Result'], rows));
  return 0;
}

// ── F4 data commands (Manager API endpoint nyata) ────────────────────────────

async function cmdProjectCreate(parsed) {
  const f = parsed.flags;
  const name = typeof f.name === 'string' && f.name ? f.name : null;
  if (!name) throw new VmPanelError(VALIDATION, 'project create butuh --name <name>');
  const type = typeof f.type === 'string' && f.type ? f.type : 'static';
  const body = { name, type };
  if (f.port !== undefined && f.port !== true) {
    body.port = parseNonNegInt(f.port, '--port');
  }
  const client = makeClient(parsed.flags);
  const p = await client.request('POST', '/projects', { body });
  stdout(
    [
      labelLine('ID', p.id),
      labelLine('Name', p.name),
      labelLine('Type', p.type),
      labelLine('Status', p.status),
      labelLine('Port', p.port ?? '-'),
      labelLine('Workspace', p.workspacePath ?? '-'),
    ].join('\n'),
  );
  return 0;
}

async function cmdProjectDeploy(parsed) {
  const id = parsed.args[0];
  if (!id) throw new VmPanelError(VALIDATION, 'project deploy butuh <projectId>');
  const client = makeClient(parsed.flags);
  const r = await client.request('POST', `/projects/${encodeURIComponent(id)}/deploy`, { body: {} });
  stdout(
    [
      labelLine('Deployment', r.deploymentId ?? '-'),
      labelLine('Status', r.status ?? '-'),
      labelLine('Revision', r.revision ?? '-'),
    ].join('\n'),
  );
  return r.status === 'success' ? 0 : 1;
}

async function cmdServiceList(parsed) {
  const client = makeClient(parsed.flags);
  const res = await client.request('GET', '/services');
  const rows = Array.isArray(res && res.rows) ? res.rows : [];
  if (rows.length === 0) {
    stdout('(no services)');
    return 0;
  }
  stdout(
    renderTable(
      ['ID', 'NAME', 'TYPE', 'STATUS', 'PORT', 'PID'],
      rows.map((s) => [s.id ?? '', s.name ?? '', s.type ?? '', s.status ?? '', s.port ?? '', s.pid ?? '']),
    ),
  );
  return 0;
}

async function cmdServiceShow(parsed) {
  const id = parsed.args[0];
  if (!id) throw new VmPanelError(VALIDATION, `service ${parsed.verb} butuh <serviceId>`);
  const client = makeClient(parsed.flags);
  const s = await client.request('GET', `/services/${encodeURIComponent(id)}`);
  stdout(
    [
      labelLine('ID', s.id),
      labelLine('Name', s.name),
      labelLine('Type', s.type),
      labelLine('Status', s.status),
      labelLine('PID', s.pid ?? '-'),
      labelLine('Port', s.port ?? '-'),
      labelLine('Project', s.projectId ?? '-'),
      labelLine('Enabled', s.enabled ? 'yes' : 'no'),
      labelLine('Restarts', s.restartCount ?? 0),
      labelLine('Started', s.startedAt ?? '-'),
      labelLine('Updated', s.updatedAt ?? '-'),
    ].join('\n'),
  );
  return 0;
}

async function cmdServiceHealth(parsed) {
  const id = parsed.args[0];
  if (!id) throw new VmPanelError(VALIDATION, 'service health butuh <serviceId>');
  const client = makeClient(parsed.flags);
  const h = await client.request('GET', `/services/${encodeURIComponent(id)}/health`);
  if (h && h.ok === true) {
    stdout(`health: OK (${h.type ?? '?'}, ${h.latencyMs ?? '?'}ms)`);
    return 0;
  }
  stdout(`health: FAIL${h && h.error ? ` — ${h.error}` : ''}`);
  return 1;
}

async function cmdServiceAction(parsed) {
  const id = parsed.args[0];
  if (!id) throw new VmPanelError(VALIDATION, `service ${parsed.verb} butuh <serviceId>`);
  const client = makeClient(parsed.flags);
  const r = await client.request('POST', `/services/${encodeURIComponent(id)}/${parsed.verb}`, { body: {} });
  stdout(
    [
      labelLine('Service', r.serviceId ?? id),
      labelLine('Status', r.status ?? (r.pid ? 'running' : '-')),
      labelLine('PID', r.pid ?? '-'),
      labelLine('Port', r.port ?? '-'),
    ].join('\n'),
  );
  return 0;
}

async function cmdDeploymentList(parsed) {
  const f = parsed.flags;
  const query = {};
  if (f.limit !== undefined && f.limit !== true) query.limit = parseNonNegInt(f.limit, '--limit');
  if (typeof f.project === 'string') query.projectId = f.project;
  if (typeof f.status === 'string') query.status = f.status;
  const client = makeClient(parsed.flags);
  const res = await client.request('GET', '/deployments', { query });
  const rows = Array.isArray(res && res.rows) ? res.rows : [];
  if (rows.length === 0) {
    stdout('(no deployments)');
    return 0;
  }
  stdout(
    renderTable(
      ['ID', 'PROJECT', 'STATUS', 'STAGE', 'REVISION', 'STARTED'],
      rows.map((d) => [d.id ?? '', d.project_id ?? '', d.status ?? '', d.stage ?? '', d.revision ?? '', d.started_at ?? '']),
    ),
  );
  return 0;
}

async function cmdDeploymentShow(parsed) {
  const id = parsed.args[0];
  if (!id) throw new VmPanelError(VALIDATION, 'deployment show butuh <deploymentId>');
  const client = makeClient(parsed.flags);
  const d = await client.request('GET', `/deployments/${encodeURIComponent(id)}`);
  stdout(
    [
      labelLine('ID', d.id),
      labelLine('Project', d.project_id ?? '-'),
      labelLine('Status', d.status ?? '-'),
      labelLine('Stage', d.stage ?? '-'),
      labelLine('Revision', d.revision ?? '-'),
      labelLine('Actor', d.actor ?? '-'),
      labelLine('Started', d.started_at ?? '-'),
      labelLine('Finished', d.finished_at ?? '-'),
      labelLine('Error', d.error ?? '-'),
      labelLine('Events', Array.isArray(d.events) ? String(d.events.length) : '0'),
      '',
      ...(Array.isArray(d.events) && d.events.length > 0
        ? [renderTable(['STAGE', 'STATUS', 'AT', 'DETAIL'], d.events.map((e) => [e.stage ?? '', e.status ?? '', e.at ?? '', (e.detail ?? '').slice(0, 60)]))]
        : []),
    ].join('\n'),
  );
  return d.status === 'success' ? 0 : 1;
}

async function cmdBackupList(parsed) {
  const f = parsed.flags;
  const query = {};
  if (f.limit !== undefined && f.limit !== true) query.limit = parseNonNegInt(f.limit, '--limit');
  const client = makeClient(parsed.flags);
  const res = await client.request('GET', '/backups', { query });
  const rows = Array.isArray(res && res.rows) ? res.rows : [];
  if (rows.length === 0) {
    stdout('(no backups)');
    return 0;
  }
  stdout(
    renderTable(
      ['ID', 'AT', 'TRIGGER', 'CLASS', 'VERIFY', 'SIZE'],
      rows.map((b) => [
        b.id ?? '',
        b.at ?? '',
        b.trigger ?? '',
        b.retention_class ?? '',
        b.verification_status ?? '',
        b.file_size ?? '',
      ]),
    ),
  );
  return 0;
}

async function cmdBackupCreate(parsed) {
  const client = makeClient(parsed.flags);
  const r = await client.request('POST', '/backups', { body: {} });
  stdout(
    [
      labelLine('Backup ID', r.backupId ?? '-'),
      labelLine('Path', r.path ?? '-'),
      labelLine('Verified', r.verification && r.verification.ok === true ? 'valid' : (r.verification?.error ?? '-')),
    ].join('\n'),
  );
  return r.verification && r.verification.ok === true ? 0 : 1;
}

async function cmdRecoveryStatus(parsed) {
  const client = makeClient(parsed.flags);
  const res = await client.request('GET', '/recovery/status');
  const rows = Array.isArray(res && res.rows) ? res.rows : [];
  if (rows.length === 0) {
    stdout('(no services)');
    return 0;
  }
  stdout(
    renderTable(
      ['SERVICE', 'NAME', 'STATUS', 'SUP.STATE', 'RESTARTS', 'CRASH_LOOP', 'BACKOFF_UNTIL'],
      rows.map((r) => [
        r.serviceId ?? '',
        r.name ?? '',
        r.status ?? '',
        r.supervisor?.state ?? '-',
        r.supervisor?.restartCount ?? 0,
        r.supervisor?.crashLoop ? 'yes' : 'no',
        r.supervisor?.backoffUntil ?? '-',
      ]),
    ),
  );
  return 0;
}

/**
 * Stub command F2/F3. Verb destruktif tetap menjalankan two-phase confirm
 * (mekanisme reusable); setelah itu tampilkan pesan not-implemented exit 2.
 */
async function notImplemented(parsed) {
  if (isDestructive(parsed)) {
    const target = parsed.args[0] || parsed.verb;
    const confirmed = await confirmTwoPhase(
      [
        'Two-phase confirmation required (destructive operation).',
        `Operation: ${parsed.noun} ${parsed.verb}`,
        `Target   : ${target}`,
      ],
      target,
    );
    if (!confirmed) {
      process.stderr.write('aborted: confirmation did not match (operation NOT executed)\n');
      return 1;
    }
  }
  stdout(`${parsed.noun} ${parsed.verb}: not implemented yet (F2/F3)`);
  return 2;
}

async function dispatch(parsed) {
  switch (parsed.noun) {
    case 'help':
      stdout(HELP);
      return 0;
    case 'health':
      return cmdHealth(parsed);
    case 'system':
      return cmdSystem(parsed);
    case 'project':
      if (parsed.verb === 'list') return cmdProjectList(parsed);
      if (parsed.verb === 'create') return cmdProjectCreate(parsed);
      if (parsed.verb === 'deploy') return cmdProjectDeploy(parsed);
      return notImplemented(parsed);
    case 'service':
      if (parsed.verb === 'list') return cmdServiceList(parsed);
      if (parsed.verb === 'show' || parsed.verb === 'status') return cmdServiceShow(parsed);
      if (parsed.verb === 'health') return cmdServiceHealth(parsed);
      if (parsed.verb === 'start' || parsed.verb === 'stop' || parsed.verb === 'restart') {
        return cmdServiceAction(parsed);
      }
      return notImplemented(parsed);
    case 'deployment':
      if (parsed.verb === 'list') return cmdDeploymentList(parsed);
      if (parsed.verb === 'show') return cmdDeploymentShow(parsed);
      return notImplemented(parsed);
    case 'backup':
      if (parsed.verb === 'list') return cmdBackupList(parsed);
      if (parsed.verb === 'create') return cmdBackupCreate(parsed);
      return notImplemented(parsed);
    case 'recovery':
      if (parsed.verb === 'status') return cmdRecoveryStatus(parsed);
      return notImplemented(parsed);
    case 'audit':
      if (parsed.verb === 'list') return cmdAuditList(parsed);
      return notImplemented(parsed);
    default:
      return notImplemented(parsed);
  }
}

/**
 * Entry utama (bisa diuji unit tanpa spawn proses).
 * @param {string[]} argv argv tanpa node + script path
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgv(argv);
    return await dispatch(parsed);
  } catch (err) {
    printError(err);
    return 1;
  }
}

// Main entry guard: jalankan hanya bila file ini dieksekusi langsung,
// bukan saat di-import oleh unit test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      printError(err);
      process.exitCode = 1;
    });
}
