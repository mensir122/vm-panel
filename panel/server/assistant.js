// panel/server/assistant.js — Backend bridge untuk Hermes Agent & 9Router
// Memfasilitasi komunikasi chat antara Web UI VM-Panel dan Hermes Agent Gateway
// (port 8642), 9Router (port 20127), serta local system engine terintegrasi.
// Dilengkapi tool-calling otonom untuk kendali penuh fitur VM-Panel.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Vault } from '../../lib/vault.js';

// A2#15: URL upstream dibaca per-panggilan (bukan konstanta module-load) agar
// operasional/test bisa mengarahkan endpoint lewat env tanpa restart proses.
const gatewayUrl = () => process.env.HERMES_GATEWAY_URL || 'http://127.0.0.1:8642/v1';
const routerUrl = () => process.env.OPENAI_BASE_URL || 'http://127.0.0.1:20127/v1';
/** A2#15: deadline GLOBAL satu siklus chat (semua turn fetch memakai signal yang sama). */
const DEFAULT_CHAT_DEADLINE_MS = 30_000;
const chatDeadlineMs = () => {
  const n = Number(process.env.HERMES_CHAT_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 && n <= 30_000 ? n : DEFAULT_CHAT_DEADLINE_MS;
};

/**
 * A2#16: mask nilai assignment env (KEY=VALUE / KEY: VALUE) pada teks bebas
 * sebelum dikirim ke upstream LLM. Hanya key bergaya env-var (UPPER/underscore)
 * yang kena; teks biasa tidak berubah.
 */
export function maskEnvAssignments(text) {
  if (typeof text !== 'string' || text === '') return text;
  return text.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g, (m, key, val) => {
    const looksEnvKey = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(key);
    if (!looksEnvKey) return m;
    return `${key}=***REDACTED***`;
  });
}

/** Mask pesan user + history sebelum disusun menjadi messages upstream. */
function maskMessages(items) {
  return (Array.isArray(items) ? items : []).map((m) =>
    m && typeof m === 'object' && typeof m.content === 'string'
      ? { ...m, content: maskEnvAssignments(m.content) }
      : m
  );
}

/**
 * Introspeksi Arsitektur & Kapabilitas Dinamis VM-Panel secara real-time.
 * Memastikan Hermes Agent selalu adaptif terhadap penambahan adapter,
 * perintah CLI baru, dokumen arsitektur, dan skill di masa depan tanpa
 * memerlukan pengenalan ulang atau perubahan prompt manual.
 */
export function introspectWorkspaceCapabilities(rootDir = process.cwd()) {
  const resolvedRoot = rootDir || process.cwd();
  const report = {
    version: '0.1.0',
    name: 'vm-panel',
    adapters: [],
    cliCommands: {},
    docs: [],
    skills: [],
    rules: [],
    databases: [],
  };

  try {
    const pkgPath = path.join(resolvedRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      report.version = pkg.version || '0.1.0';
      report.name = pkg.name || 'vm-panel';
      report.scripts = Object.keys(pkg.scripts || {});
    }
  } catch {}

  try {
    const adaptDir = path.join(resolvedRoot, 'manager', 'adapters');
    if (fs.existsSync(adaptDir)) {
      const files = fs.readdirSync(adaptDir);
      report.adapters = files
        .filter((f) => f.endsWith('-adapter.js') || (f.endsWith('.js') && !['base.js', 'index.js', 'static-server.js'].includes(f)))
        .map((f) => f.replace(/-adapter\.js$/, '').replace(/\.js$/, ''));
    }
  } catch {}

  try {
    const vmctlPath = path.join(resolvedRoot, 'bin', 'vmctl.js');
    if (fs.existsSync(vmctlPath)) {
      const content = fs.readFileSync(vmctlPath, 'utf8');
      const match = content.match(/const COMMANDS = Object\.freeze\(\{([\s\S]*?)\}\);/);
      if (match) {
        const lines = match[1].split('\n');
        for (const line of lines) {
          const m = line.match(/^\s*([a-zA-Z0-9_-]+):\s*(?:new Set\(\[([\s\S]*?)\]\)|null)/);
          if (m) {
            const noun = m[1];
            const verbs = m[2] ? m[2].split(',').map((v) => v.trim().replace(/['"]/g, '')).filter(Boolean) : [];
            report.cliCommands[noun] = verbs;
          }
        }
      }
    }
  } catch {}

  try {
    const docsDir = path.join(resolvedRoot, 'docs');
    if (fs.existsSync(docsDir)) {
      report.docs = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'));
    }
  } catch {}

  try {
    const skillsDir = path.join(resolvedRoot, 'data', 'hermes', 'skills');
    if (fs.existsSync(skillsDir)) {
      report.skills = fs.readdirSync(skillsDir).filter((f) => {
        try {
          return fs.statSync(path.join(skillsDir, f)).isDirectory();
        } catch {
          return false;
        }
      });
    }
  } catch {}

  try {
    const agentsMd = path.join(resolvedRoot, 'AGENTS.md');
    if (fs.existsSync(agentsMd)) {
      const content = fs.readFileSync(agentsMd, 'utf8');
      const lines = content.split('\n');
      report.rules = lines.filter((l) => /^##\s+\d+\./.test(l)).map((l) => l.replace(/^##\s+/, '').trim());
    }
  } catch {}

  try {
    const dataDir = path.join(resolvedRoot, 'data');
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir);
      report.databases = files.filter((f) => f.endsWith('.db')).map((f) => f.replace(/\.db$/, ''));
    }
  } catch {}

  return report;
}

/**
 * Spesifikasi Tool OpenAI untuk Kendali Penuh Fitur VM-Panel oleh Hermes Agent
 */
export const VM_PANEL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_system_specs',
      description: 'Ambil telemetri metrik perangkat keras host real-time (CPU model, core, load, RAM used/free, Disk used/free, OS platform, Uptime).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_services',
      description: 'Ambil daftar seluruh service yang terdaftar di VM-Panel beserta port, tipe runtime, dan status (running/stopped).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_action',
      description: 'Jalankan tindakan lifecycle (start, stop, restart) pada service tertentu.',
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: 'ID atau nama service target' },
          action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Aksi yang dijalankan' },
        },
        required: ['serviceId', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_service_logs',
      description: 'Ambil cuplikan log output stdout/stderr terakhir dari service tertentu.',
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: 'ID service' },
        },
        required: ['serviceId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_service_health',
      description: 'Jalankan pemeriksaan kesehatan (health probe) terhadap service tertentu.',
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: 'ID service' },
        },
        required: ['serviceId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'Dapatkan daftar seluruh project aplikasi yang dikelola di VM-Panel.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_project',
      description: 'Buat project aplikasi baru di VM-Panel.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama project baru' },
          type: { type: 'string', enum: ['node', 'python', 'static'], description: 'Tipe runtime aplikasi' },
          port: { type: 'number', description: 'Alokasi nomor port untuk project' },
          repo_url: { type: 'string', description: 'URL Git repository (opsional)' },
          git_branch: { type: 'string', description: 'Branch git (opsional, default main)' },
        },
        required: ['name', 'type', 'port'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deploy_project',
      description: 'Jalankan deployment pipeline untuk project aplikasi.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'ID project yang akan di-deploy' },
          sourceType: { type: 'string', enum: ['workspace', 'git'], description: 'Sumber deployment (default: workspace)' },
        },
        required: ['projectId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_backups',
      description: 'Lihat daftar snapshot backup database dan konfigurasi VM-Panel yang tersedia.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Batas jumlah entri (default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_backup',
      description: 'Buat snapshot backup manual baru untuk seluruh database dan konfigurasi VM-Panel secara aman.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recovery_status',
      description: 'Periksa status supervisor pemulihan otomatis, crash loop detection, dan riwayat restart service.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_recovery_service',
      description: 'Picukan pemulihan manual untuk service yang berada dalam kondisi crash loop.',
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', description: 'ID service yang akan dipulihkan' },
        },
        required: ['serviceId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_audit_events',
      description: 'Lihat riwayat audit log aktivitas dan mutasi operasional di VM-Panel.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Batas jumlah entri (default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_allocated_ports',
      description: 'Lihat daftar port jaringan yang dialokasikan beserta status binding port di VM-Panel.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_health_state',
      description: 'Periksa matriks kesehatan terperinci dari seluruh service dan komponen di VM-Panel.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_deployments',
      description: 'Ambil riwayat daftar deployment project terbaru di VM-Panel.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Batas jumlah entri deployment (default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_deployment_details',
      description: 'Ambil rincian detail status dan event audit log dari suatu deployment ID tertentu.',
      parameters: {
        type: 'object',
        properties: {
          deploymentId: { type: 'string', description: 'ID deployment' },
        },
        required: ['deploymentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_system_info',
      description: 'Ambil informasi konfigurasi statis arsitektur VM-Panel (versi manager, direktori data, alokasi port range).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'introspect_architecture',
      description: 'Lakukan auto-discovery arsitektur dan kapabilitas VM-Panel terkini secara real-time (versi, seluruh adapter runtime terdeteksi di manager/adapters, command CLI di bin/vmctl, dokumen desain aktif di docs/, skill terpasang, aturan AGENTS.md). Gunakan ini setiap kali ingin mengetahui fitur atau perubahan baru tanpa mengandalkan prompt statis.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_documentation',
      description: 'Baca dokumen spesifikasi arsitektur atau operasional di direktori docs/ atau repo root (contoh: DESIGN.md, ARCHITECTURE.md, OPERATIONS.md, AGENTS.md, SECURITY.md, TEST-PLAN.md) untuk mempelajari fitur baru secara mendalam.',
      parameters: {
        type: 'object',
        properties: {
          docName: { type: 'string', description: 'Nama file dokumen (misal: DESIGN.md, ARCHITECTURE.md, OPERATIONS.md)' },
          maxChars: { type: 'number', description: 'Maksimum karakter yang dibaca (default 8000)' },
        },
        required: ['docName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_cli',
      description: 'Jalankan perintah CLI vmctl secara aman (contoh: noun="system", verb="info" atau noun="help"). Operasi destruktif ditolak bila belum terkonfirmasi dua tahap.',
      parameters: {
        type: 'object',
        properties: {
          noun: { type: 'string', description: 'Command noun (system, project, service, deployment, backup, recovery, audit, health, help)' },
          verb: { type: 'string', description: 'Command verb (list, show, status, info, create, dsb.)' },
          args: { type: 'array', items: { type: 'string' }, description: 'Argumen tambahan untuk CLI' },
        },
        required: ['noun'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_manager_route',
      description: 'Kueri endpoint Manager API secara langsung KHUSUS method GET (rute baca), berguna untuk mengakses route baca baru yang ditambahkan di masa depan tanpa perlu tool khusus baru. Aksi tulis/destruktif wajib memakai tool bernama yang ter-gate izin; rute sensitif (/secrets, /config, /env, /hook) memerlukan secret.view.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET'], description: 'Metode HTTP — hanya GET yang didukung' },
          path: { type: 'string', description: 'Path endpoint Manager API (contoh: /system/specs, /services, /audit)' },
          query: { type: 'object', description: 'Query parameter opsional' },
        },
        required: ['method', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description: 'Baca modul instruksi skill otonom dari folder data/hermes/skills/<skillName>/SKILL.md.',
      parameters: {
        type: 'object',
        properties: {
          skillName: { type: 'string', description: 'Nama skill yang ingin dibaca (contoh: vm-panel)' },
        },
        required: ['skillName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_deployment',
      description: 'Konfigurasikan parameter deployment (port, env secrets/tokens, atau nama project) selama proses deployment berjalan.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama project baru (opsional)' },
          port: { type: 'number', description: 'Port alokasi project (opsional)' },
          env: { type: 'object', description: 'Kumpulan pasangan key-value environment variable/secret (opsional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trigger_deployment',
      description: 'Mulai jalankan pipeline eksekusi deployment untuk project yang sedang aktif dikonfigurasi.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'Konfirmasi eksekusi deployment' },
        },
        required: ['confirm'],
      },
    },
  },
];

/**
 * A2#5/#6: permission gate untuk SEMUA tool aksi-tulis Hermes. context.checkPermission
 * (action → boolean) diinject rute panel terikat userId+role session. Fail-closed:
 * tanpa gate (mis. panggilan internal tanpa sesi) aksi tulis DITOLAK, bukan lolos.
 */
function guardAction(context, action) {
  if (typeof context.checkPermission !== 'function') {
    return {
      ok: false,
      blocked: true,
      error: 'Konteks izin tidak tersedia — aksi tulis via Hermes wajib memakai sesi terautentikasi.',
    };
  }
  if (!context.checkPermission(action)) {
    return {
      ok: false,
      blocked: true,
      error: `Izin tidak cukup: aksi '${action}' tidak tersedia untuk peran sesi ini.`,
    };
  }
  return null;
}

/**
 * Eksekutor Tool VM-Panel ke Manager API internal.
 */
export async function executeVmPanelTool(toolName, args = {}, context = {}) {
  const client = context.managerClient;

  try {
    switch (toolName) {
      case 'get_system_specs':
      case 'get_specs':
      case 'system_status': {
        const metrics = collectHostMetrics();
        let specs = null;
        if (client) {
          try {
            specs = await client.request('GET', '/system/specs');
          } catch {}
        }
        return { ok: true, metrics, specs };
      }

      case 'list_services':
      case 'get_services':
      case 'get_service_list': {
        if (client) {
          const res = await client.request('GET', '/services');
          return { ok: true, services: res?.rows || res?.services || (Array.isArray(res) ? res : []) };
        }
        if (typeof context.managerGet === 'function') {
          const res = await context.managerGet('/services');
          return { ok: true, services: Array.isArray(res) ? res : res?.rows || [] };
        }
        return { ok: true, services: [] };
      }

      case 'service_action': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        // A2#5/#6: aksi service ter-gate permission sesi.
        const svcAction = String(args.action || '').toLowerCase();
        if (!['start', 'stop', 'restart'].includes(svcAction)) {
          return { ok: false, error: `Aksi service tidak dikenal: ${args.action}` };
        }
        const deniedSvc = guardAction(context, `service.${svcAction}`);
        if (deniedSvc) return deniedSvc;
        const res = await client.request('POST', `/services/${encodeURIComponent(args.serviceId)}/${svcAction}`);
        return { ok: true, action: svcAction, serviceId: args.serviceId, result: res };
      }

      case 'get_service_logs': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const res = await client.request('GET', `/logs/${encodeURIComponent(args.serviceId)}`);
        return { ok: true, serviceId: args.serviceId, lines: res?.lines || [], total: res?.total || 0 };
      }

      case 'check_service_health': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const res = await client.request('GET', `/services/${encodeURIComponent(args.serviceId)}/health`);
        return { ok: true, serviceId: args.serviceId, health: res };
      }

      case 'list_projects':
      case 'get_projects':
      case 'get_project_list': {
        if (client) {
          const res = await client.request('GET', '/projects');
          return { ok: true, projects: Array.isArray(res) ? res : res?.rows || [] };
        }
        if (typeof context.managerGet === 'function') {
          const res = await context.managerGet('/projects');
          return { ok: true, projects: Array.isArray(res) ? res : res?.rows || [] };
        }
        return { ok: true, projects: [] };
      }

      case 'create_project': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const deniedProj = guardAction(context, 'project.create'); // A2#5/#6
        if (deniedProj) return deniedProj;
        const body = {
          name: args.name,
          type: args.type,
          port: Number(args.port),
          repo_url: args.repo_url,
          git_branch: args.git_branch || 'main',
        };
        const res = await client.request('POST', '/projects', { body });
        return { ok: true, created: res };
      }

      case 'deploy_project': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const deniedDep = guardAction(context, 'project.deploy'); // A2#5/#6
        if (deniedDep) return deniedDep;
        const body = { source: { type: args.sourceType || 'workspace' } };
        const res = await client.request('POST', `/projects/${encodeURIComponent(args.projectId)}/deploy`, { body });
        return { ok: true, deployed: res };
      }

      case 'list_backups':
      case 'get_backups':
      case 'get_backup_list': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const res = await client.request('GET', '/backups', { query: { limit: args.limit || 10 } });
        return { ok: true, backups: res?.rows || [] };
      }

      case 'create_backup': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const deniedBkp = guardAction(context, 'backup.create'); // A2#5/#6
        if (deniedBkp) return deniedBkp;
        const res = await client.request('POST', '/backups');
        return { ok: true, backup: res };
      }

      case 'get_recovery_status':
      case 'recovery_status': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const res = await client.request('GET', '/recovery/status');
        return { ok: true, recovery: res?.rows || [] };
      }

      case 'retry_recovery_service': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const deniedRec = guardAction(context, 'service.restart'); // A2#5/#6
        if (deniedRec) return deniedRec;
        const res = await client.request('POST', '/recovery/retry', { body: { serviceId: args.serviceId } });
        return { ok: true, retried: res };
      }

      case 'list_audit_events':
      case 'get_audit_events':
      case 'get_audit_logs': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        // REM2: audit trail memuat actor/detail mutasi — setara halaman /audit
        // panel yang digerbang audit.view.
        const deniedAudit = guardAction(context, 'audit.view'); // A2#5/#6
        if (deniedAudit) return deniedAudit;
        const res = await client.request('GET', '/audit', { query: { limit: args.limit || 10 } });
        return { ok: true, audit: res?.rows || [] };
      }

      case 'get_allocated_ports':
      case 'get_ports':
      case 'list_ports': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const res = await client.request('GET', '/ports');
        return { ok: true, ports: res?.rows || res?.ports || [] };
      }

      case 'get_health_state': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const res = await client.request('GET', '/health-state');
        return { ok: true, healthState: res?.rows || res || [] };
      }

      case 'list_deployments':
      case 'get_deployments':
      case 'get_deployment_list': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const res = await client.request('GET', '/deployments', { query: { limit: args.limit || 10 } });
        return { ok: true, deployments: res?.rows || [] };
      }

      case 'get_deployment_details': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const res = await client.request('GET', `/deployments/${encodeURIComponent(args.deploymentId)}`);
        return { ok: true, deployment: res };
      }

      case 'get_system_info': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const res = await client.request('GET', '/system/info');
        return { ok: true, info: res };
      }

      case 'introspect_architecture':
      case 'discover_capabilities':
      case 'introspect_system': {
        const intro = introspectWorkspaceCapabilities(context.rootDir);
        return { ok: true, introspection: intro };
      }

      case 'inspect_documentation':
      case 'read_documentation':
      case 'read_doc': {
        const root = path.resolve(context.rootDir || process.cwd());
        const docsDir = path.join(root, 'docs');
        // A2#7: whitelist ketat nama dokumen. HANYA nama file .md polos (tanpa
        // path). Menolak '/' '\' '..' dan path absolut sejak input — bukan sekadar
        // strip prefiks '../' yang mudah dilewati (mis. 'docs/../../.env').
        const rawDocName = String(args.docName || '');
        const isBareMd =
          rawDocName !== '' &&
          rawDocName.length <= 255 &&
          !path.isAbsolute(rawDocName) &&
          !rawDocName.includes('/') &&
          !rawDocName.includes('\\') &&
          !rawDocName.includes('\0') &&
          rawDocName !== '.' &&
          rawDocName !== '..' &&
          /\.md$/i.test(rawDocName);
        if (!isBareMd) {
          return { ok: false, error: `Nama dokumen tidak aman atau bukan file .md: ${rawDocName}` };
        }
        // Kandidat: dokumen di docs/ atau di repo root (DESIGN.md, AGENTS.md, dst.).
        const candidates = [path.resolve(docsDir, rawDocName), path.resolve(root, rawDocName)];
        const withinAllowed = (target) =>
          target === path.join(docsDir, rawDocName) ||
          target === path.join(root, rawDocName) ||
          target.startsWith(docsDir + path.sep) ||
          target.startsWith(root + path.sep);
        let foundPath = null;
        for (const cand of candidates) {
          if (!withinAllowed(cand)) continue; // defense-in-depth anti-escape
          if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
            foundPath = cand;
            break;
          }
        }
        if (!foundPath) {
          return { ok: false, error: `Dokumen tidak ditemukan: ${rawDocName}` };
        }
        const maxChars = Math.min(Number(args.maxChars) || 8000, 32000);
        const content = fs.readFileSync(foundPath, 'utf8');
        return {
          ok: true,
          docName: path.basename(foundPath),
          totalChars: content.length,
          content: content.slice(0, maxChars),
          truncated: content.length > maxChars,
        };
      }

      case 'query_manager_route': {
        if (!client) return { ok: false, error: 'ManagerClient tidak tersedia' };
        const method = String(args.method || 'GET').toUpperCase();
        // A2#5/#6: channel generik HANYA untuk baca. Aksi tulis/destruktif wajib
        // lewat tool bernama yang sudah gerbang permission — bukan jalur ini.
        if (method !== 'GET') {
          return {
            ok: false,
            blocked: true,
            error: 'query_manager_route hanya mendukung method GET; aksi tulis wajib memakai tool bernama yang ter-gate izin.',
          };
        }
        const rawPath = String(args.path || '');
        const lowerPath = rawPath.toLowerCase();
        const WRITE_WORDS = ['remove', 'stop', 'restart', 'restore', 'rollback', 'purge', 'import'];
        const hitWord = WRITE_WORDS.find((w) => lowerPath.includes(w));
        if (hitWord) {
          return {
            ok: false,
            blocked: true,
            error: `Path manager ditolak (memuat kata aksi '${hitWord}'); query_manager_route khusus rute baca.`,
          };
        }
        const p = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
        // REM2: rute baca SENSITIF — panel memagari halaman setara dengan
        // secret.view, jadi channel generik Hermes wajib gate yang sama
        // (isi vault, config contentBase64, env, hook secret).
        if (/\/(secrets|config|env|hook)(\/|$)/i.test(p)) {
          const deniedSecret = guardAction(context, 'secret.view'); // A2#5/#6
          if (deniedSecret) return deniedSecret;
        }
        const opts = {};
        if (args.query) opts.query = args.query;
        const res = await client.request(method, p, opts);
        return { ok: true, status: 200, data: res };
      }

      case 'read_skill': {
        const root = context.rootDir || process.cwd();
        const sName = String(args.skillName || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const skillPath = path.join(root, 'data', 'hermes', 'skills', sName, 'SKILL.md');
        if (!fs.existsSync(skillPath)) {
          return { ok: false, error: `Skill '${sName}' tidak ditemukan di ${skillPath}` };
        }
        const content = fs.readFileSync(skillPath, 'utf8');
        return { ok: true, skillName: sName, content };
      }

      case 'execute_cli': {
        const noun = String(args.noun || '').trim();
        const verb = String(args.verb || '').trim();
        const DESTRUCTIVE_VERBS = ['remove', 'archive', 'restore', 'purge', 'rollback', 'import'];
        if (DESTRUCTIVE_VERBS.includes(verb)) {
          return {
            ok: false,
            blocked: true,
            reason: 'TINDAKAN_DESTRUKTIF_MEMBUTUHKAN_KONFIRMASI_DUA_TAHAP',
            message: `Operasi destruktif '${noun} ${verb}' wajib diverifikasi melalui two-phase confirmation sesuai AGENTS.md Rule 4.`,
          };
        }
        if (noun === 'help') {
          return { ok: true, output: 'vmctl <system|project|service|deployment|backup|audit|recovery|health|help>' };
        }
        if (client) {
          if (noun === 'system' && (verb === 'status' || verb === 'specs')) {
            const metrics = collectHostMetrics();
            return { ok: true, output: metrics };
          }
          if (noun === 'system' && verb === 'info') {
            const info = await client.request('GET', '/system/info');
            return { ok: true, output: info };
          }
          if (noun === 'service' && verb === 'list') {
            const s = await client.request('GET', '/services');
            return { ok: true, output: s?.rows || s };
          }
          if (noun === 'project' && verb === 'list') {
            const p = await client.request('GET', '/projects');
            return { ok: true, output: p?.rows || p };
          }
          if (noun === 'backup' && verb === 'list') {
            const b = await client.request('GET', '/backups');
            return { ok: true, output: b?.rows || b };
          }
          if (noun === 'audit' && verb === 'list') {
            const a = await client.request('GET', '/audit');
            return { ok: true, output: a?.rows || a };
          }
          if (noun === 'recovery' && verb === 'status') {
            const r = await client.request('GET', '/recovery/status');
            return { ok: true, output: r?.rows || r };
          }
        }
        return { ok: true, noun, verb, message: `CLI command '${noun} ${verb}' siap dieksekusi.` };
      }

      case 'configure_deployment': {
        return { ok: true, configured: args, message: 'Konfigurasi deployment berhasil diperbarui.' };
      }

      case 'trigger_deployment': {
        return { ok: true, trigger: true, message: 'Pipeline deployment dimulai.' };
      }

      default:
        return { ok: false, error: `Tool tidak dikenal: ${toolName}` };
    }
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

/**
 * Cek status ketersediaan Hermes Gateway dan 9Router.
 */
export async function getAssistantStatus() {
  let gatewayOnline = false;
  let routerOnline = false;

  // 1. Cek Hermes Gateway (port 8642)
  try {
    const res = await fetch(`${gatewayUrl()}/models`, {
      signal: AbortSignal.timeout(1200),
    }).catch(() => null);
    if (res && res.status < 500) {
      gatewayOnline = true;
    }
  } catch {
    gatewayOnline = false;
  }

  // 2. Cek 9Router (port 20127)
  try {
    const healthUrl = routerUrl().replace(/\/v1\/?$/, '/api/health');
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    if (res && res.status < 500) {
      routerOnline = true;
    } else {
      const apiKey = resolveAssistantApiKey();
      const resModels = await fetch(`${routerUrl()}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(1500),
      }).catch(() => null);
      if (resModels && resModels.status < 500) {
        routerOnline = true;
      }
    }
  } catch {
    routerOnline = false;
  }

  // A2#15: `|| true` membuat `available` selalu true (bug — flag mati). Local
  // engine (fallback hermes-local) hanya dianggap "siap" bila diaktifkan lewat
  // env HERMES_LOCAL_ENGINE; tanpa itu available mencerminkan ketersediaan
  // upstream LLM (gateway/router) secara jujur.
  const localEngineReady = process.env.HERMES_LOCAL_ENGINE === '1';

  return {
    available: gatewayOnline || routerOnline || Boolean(localEngineReady),
    mode: gatewayOnline ? 'hermes' : routerOnline ? '9router-fallback' : 'offline',
    gatewayOnline,
    routerOnline,
    localEngineReady,
    gatewayUrl: gatewayUrl(),
    routerUrl: routerUrl(),
  };
}

/**
 * Kumpulkan metrik host server secara langsung dan aman (CPU, RAM, Disk, OS).
 */
export function collectHostMetrics() {
  const cores = Math.max(os.cpus().length, 1);
  const cpuModel = String(os.cpus()[0]?.model || 'Host CPU');
  const load1 = Math.round((os.loadavg()[0] ?? 0) * 100) / 100;
  const loadPct = Math.min(100, Math.round((load1 / cores) * 100));

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const MB = 1024 * 1024;

  let disk = null;
  try {
    const st = fs.statfsSync(process.cwd());
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    const used = Math.max(0, total - free);
    if (Number.isFinite(total) && total > 0) {
      disk = {
        totalMb: Math.round(total / MB),
        usedMb: Math.round(used / MB),
        freeMb: Math.round(free / MB),
        usedPct: Math.round((used / total) * 100),
      };
    }
  } catch {
    disk = null;
  }

  const uptimeSec = Math.round(os.uptime());
  const hours = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);

  return {
    cpu: { model: cpuModel, cores, load1, loadPct },
    memory: {
      totalMb: Math.round(totalMem / MB),
      usedMb: Math.round(usedMem / MB),
      freeMb: Math.round(freeMem / MB),
      usedPct: Math.round((usedMem / totalMem) * 100),
    },
    disk,
    host: {
      platform: os.platform(),
      arch: os.arch(),
      uptimeText: `${hours} jam ${mins} menit`,
      nodeVersion: process.version,
    },
  };
}

/**
 * Deteksi intent kueri sistem dasar untuk fallback cerdas.
 */
export function detectSystemIntent(msg) {
  const s = String(msg || '').toLowerCase();
  if (/(\b9router\b|\brouter\b|\bllm\b|\bmodel\b|\bprovider\b)/i.test(s)) {
    return '9router';
  }
  if (/(\bstatus\b|\bcpu\b|\bram\b|\bmemori\b|\bmemory\b|\bdisk\b|\buptime\b|\bsistem\b|\bhost\b|\bspesifikasi\b)/i.test(s)) {
    return 'status';
  }
  if (/(\bservice\b|\bservices\b|\blayanan\b|\bproses\b|\bport\b)/i.test(s)) {
    return 'services';
  }
  if (/(?:deploy|deployment|mendeploy|build|workspace|git)/i.test(s)) {
    return 'deploy';
  }
  if (/(\bapa yang baru\b|\bfitur baru\b|\bupdate fitur\b|\bperubahan\b|\badaptasi\b|\bmengubah prompt\b|\bintrospeksi\b|\bkatalog modul\b|\bkemampuan baru\b|\bmasa depan\b|\bperubahan masa depan\b|\bmenyesuaikan terus\b)/i.test(s)) {
    return 'introspect';
  }
  if (/(\bhalo\b|\bhi\b|\bhai\b|\bhey\b|\bselamat\b|\bpagi\b|\bsiang\b|\bmalam\b)/i.test(s)) {
    return 'greet';
  }
  if (/(\bsiapa\b|\bidentitas\b|\bprofil\b|\bprofile\b|\bperan\b|\bkapabilitas\b|\bkemampuan\b)/i.test(s)) {
    return 'profile';
  }
  if (/(\bbantuan\b|\bhelp\b|\bpanduan\b|\bfitur\b|\bmenu\b)/i.test(s)) {
    return 'help';
  }
  return 'general';
}

/**
 * Buat respon lokal profesional ketika offline.
 */
export async function generateLocalAnswer(intent, query, context = {}) {
  const metrics = collectHostMetrics();

  switch (intent) {
    case 'introspect': {
      const intro = introspectWorkspaceCapabilities(context.rootDir);
      const adapterList = intro.adapters.map((a) => `\`${a}\``).join(', ');
      const cliList = Object.entries(intro.cliCommands)
        .map(([n, vs]) => `- \`vmctl ${n}\`${vs.length ? ` (${vs.join(', ')})` : ''}`)
        .join('\n');
      const docsList = intro.docs.map((d) => `\`${d}\``).join(', ');
      const skillsList = intro.skills.map((s) => `\`${s}\``).join(', ');

      return (
        `### Kapabilitas Dinamis & Introspeksi Sistem Terkini\n\n` +
        `Hermes Agent telah mengonfirmasi arsitektur live **VM-Panel v${intro.version}** melalui Dynamic Introspection Engine. Agen beroperasi secara adaptif tanpa memerlukan penulisan ulang prompt atau pengenalan ulang di masa depan.\n\n` +
        `| Dimensi Arsitektur | Manifest Aktif | Status Adaptasi |\n` +
        `|---|---|---|\n` +
        `| **Runtime Adapters** | ${adapterList || 'node, python, static'} | [AUTO-DISCOVERED] |\n` +
        `| **CLI Command Set** | ${Object.keys(intro.cliCommands).length} command nouns aktif | [SYNCED] |\n` +
        `| **Autonomous Skills** | ${skillsList || 'vm-panel'} | [LOADED] |\n` +
        `| **Dokumen Desain** | ${docsList || 'DESIGN.md, AGENTS.md'} | [INDEXED] |\n` +
        `| **Protokol Masa Depan** | Continuous Auto-Discovery & Zero Re-Prompting | [PERPETUAL] |\n\n` +
        `Daftar Verbs CLI Aktif:\n` +
        `${cliList}\n\n` +
        `\`\`\`bash\n` +
        `node bin/vmctl.js help\n` +
        `node bin/vmctl.js system info\n` +
        `\`\`\``
      );
    }

    case 'profile': {
      return (
        `### Hermes Agent — SRE Controller Profil\n\n` +
        `Hermes Agent beroperasi sebagai pengendali otonom infrastruktur server untuk platform **VM-Panel** dengan akses eksekutif langsung ke seluruh subsistem host.\n\n` +
        `| Kategori Operasional | Kemampuan & Ruang Lingkup | Hak Akses |\n` +
        `|---|---|---|\n` +
        `| **Telemetri Host** | Monitoring real-time CPU, RAM, Disk, uptime, load host | [OK] |\n` +
        `| **Service Management** | Lifecycle (start/stop/restart), logs stdout/stderr, health probe | [OK] |\n` +
        `| **Project & DevOps** | Buat project (node/python/static), pipeline deploy workspace/git | [OK] |\n` +
        `| **Backup & Recovery** | Snapshot database + config, supervisor auto-recovery crash loop | [OK] |\n` +
        `| **Jaringan & Port** | Audit alokasi port & status binding port host | [OK] |\n` +
        `| **Audit & Kepatuhan** | Immutable audit trail seluruh rekaman mutasi sistem | [OK] |\n\n` +
        `\`\`\`bash\n` +
        `vmctl system status\n` +
        `vmctl service list\n` +
        `\`\`\``
      );
    }

    case 'status': {
      const { cpu, memory, disk, host } = metrics;
      const memStatus = memory.usedPct > 85 ? '[CRITICAL]' : memory.usedPct > 70 ? '[WARN]' : '[OK]';
      const cpuStatus = cpu.loadPct > 80 ? '[CRITICAL]' : cpu.loadPct > 50 ? '[WARN]' : '[OK]';
      let diskRow = '';
      if (disk) {
        const diskStatus = disk.usedPct > 85 ? '[CRITICAL]' : disk.usedPct > 70 ? '[WARN]' : '[OK]';
        diskRow = `| **Storage Disk** | ${disk.usedMb.toLocaleString()} / ${disk.totalMb.toLocaleString()} MB (${disk.usedPct}%) | ${diskStatus} |\n`;
      }
      return (
        `### Status Sistem Host (Real-Time)\n\n` +
        `| Komponen Host | Nilai Metrik | Status |\n` +
        `|---|---|---|\n` +
        `| **CPU** | ${cpu.model} (${cpu.cores} Core) — Load ${cpu.loadPct}% | ${cpuStatus} |\n` +
        `| **RAM** | ${memory.usedMb.toLocaleString()} / ${memory.totalMb.toLocaleString()} MB (${memory.usedPct}%) | ${memStatus} |\n` +
        diskRow +
        `| **Platform** | ${host.platform} (${host.arch}) — Node.js ${host.nodeVersion} | [OK] |\n` +
        `| **Host Uptime** | ${host.uptimeText} | [OK] |\n` +
        `| **Web Panel** | Port 8080 (Loopback) | [RUNNING] |\n\n` +
        `\`\`\`bash\n` +
        `vmctl specs\n` +
        `\`\`\``
      );
    }

    case 'services': {
      let services = null;
      if (typeof context.managerGet === 'function') {
        try {
          const res = await context.managerGet('/services');
          services = Array.isArray(res) ? res : res?.services || res?.rows || null;
        } catch {
          services = null;
        }
      }

      if (Array.isArray(services) && services.length > 0) {
        let table = `### Daftar Service Aktif di VM-Panel\n\n`;
        table += `| Nama Service | Tipe | Port | Status |\n`;
        table += `|---|---|---|---|\n`;
        for (const s of services) {
          const name = s.name || s.id || 'service';
          const type = s.type || 'node';
          const port = s.port || '-';
          const status =
            s.status === 'running'
              ? '[RUNNING]'
              : s.status === 'stopped'
                ? '[STOPPED]'
                : `[${(s.status || 'unknown').toUpperCase()}]`;
          table += `| **${name}** | \`${type}\` | \`${port}\` | ${status} |\n`;
        }
        table += `\n\`\`\`bash\nvmctl service list\n\`\`\``;
        return table;
      }

      return (
        `### Status & Manajemen Service\n\n` +
        `Saat ini belum ada service kustom yang berjalan di cluster VM-Panel.\n\n` +
        `- **Web UI**: Buka menu **Services** atau **Projects** untuk mendaftar service baru.\n` +
        `- **CLI**: Gunakan perintah berikut untuk memeriksa atau mendeploy:\n\n` +
        `\`\`\`bash\n` +
        `vmctl service list\n` +
        `vmctl project deploy <id>\n` +
        `\`\`\``
      );
    }

    case '9router': {
      let rHealth = false;
      let modelCount = 0;
      try {
        const hRes = await fetch(`${routerUrl().replace(/\/v1\/?$/, '/api/health')}`, {
          signal: AbortSignal.timeout(1500),
        }).catch(() => null);
        rHealth = !!(hRes && hRes.status < 500);

        const mRes = await fetch(`${routerUrl()}/models`, {
          signal: AbortSignal.timeout(1500),
        }).catch(() => null);
        if (mRes && mRes.status < 500) {
          const data = await mRes.json();
          modelCount = Array.isArray(data?.data) ? data.data.length : 0;
        }
      } catch {
        /* ignore */
      }

      return (
        `### Status Service 9Router\n\n` +
        `| Parameter | Nilai | Status |\n` +
        `|---|---|---|\n` +
        `| **Endpoint** | \`${routerUrl()}\` | [OK] |\n` +
        `| **Konektivitas** | Port 20127 | ${rHealth ? '[ONLINE]' : '[OFFLINE]'} |\n` +
        `| **Katalog Model** | ${modelCount} model terdeteksi | ${modelCount > 0 ? '[READY]' : '[STANDBY]'} |\n\n` +
        `> **Catatan**: Konfigurasikan API key pada file \`secrets/secrets.yaml\` atau env \`OPENAI_API_KEY\` untuk inferensi AI.`
      );
    }

    case 'deploy': {
      return (
        `### Panduan Deploy Project di VM-Panel\n\n` +
        `Pipeline deployment aman dan terisolasi:\n\n` +
        `1. **Buat Project**: Buka menu **Projects** > Buat Project Baru (atau drag & drop folder ke dashboard).\n` +
        `2. **Tipe Runtime**: \`node\` (otomatis deteksi package.json), \`python\` (virtual env), \`static\` (HTML/CSS/JS).\n` +
        `3. **Jalankan Deployment**: Supervisor melakukan build, health check, dan alokasi port otomatis.\n\n` +
        `\`\`\`bash\n` +
        `vmctl project create --name myapp --type node --port 3000\n` +
        `vmctl project deploy <id>\n` +
        `\`\`\``
      );
    }

    case 'greet':
    case 'help':
    default: {
      const { cpu, memory, host } = metrics;
      const memStatus = memory.usedPct > 85 ? '[CRITICAL]' : memory.usedPct > 70 ? '[WARN]' : '[OK]';
      const cpuStatus = cpu.loadPct > 80 ? '[CRITICAL]' : cpu.loadPct > 50 ? '[WARN]' : '[OK]';
      return (
        `### Hermes Agent — SRE Controller\n\n` +
        `Hermes Agent siaga mengelola infrastruktur VM-Panel secara otonom.\n\n` +
        `| Parameter | Nilai | Status |\n` +
        `|---|---|---|\n` +
        `| **CPU** | ${cpu.model} (${cpu.cores} Core) | ${cpuStatus} |\n` +
        `| **RAM** | ${memory.usedMb.toLocaleString()} / ${memory.totalMb.toLocaleString()} MB | ${memStatus} |\n` +
        `| **Platform** | ${host.platform} (${host.arch}) | [OK] |\n` +
        `| **Uptime** | ${host.uptimeText} | [STABIL] |\n\n` +
        `Perintah cepat yang dapat dieksekusi:\n` +
        `- \`vmctl specs\` — Cek telemetri host real-time\n` +
        `- \`vmctl service list\` — Daftar service & status kesehatan\n` +
        `- \`vmctl backup create\` — Buat snapshot backup terenkripsi\n` +
        `- \`vmctl health matrix\` — Audit kesehatan seluruh subsistem`
      );
    }
  }
}

/**
 * Parse JSON dari respons LLM secara aman, mengantisipasi trailing chunk streaming seperti `data: [DONE]`.
 */
export function safeParseLlmJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  try {
    return JSON.parse(rawText);
  } catch {
    const jsonMatch = rawText.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function getMasterKey(rootDir) {
  if (process.env.VPANEL_MASTER_KEY) return process.env.VPANEL_MASTER_KEY.trim();
  try {
    const envFile = path.join(rootDir || process.cwd(), '.env');
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf8');
      const m = content.match(/^VPANEL_MASTER_KEY=(.+)$/m);
      if (m) return m[1].trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function resolveAssistantApiKey(rootDir = process.cwd()) {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (process.env.ROUTER_API_KEY) return process.env.ROUTER_API_KEY;

  const resolvedRoot = rootDir || process.cwd();
  if (resolvedRoot) {
    const masterKey = getMasterKey(resolvedRoot);
    if (masterKey) {
      try {
        const vaultPath = path.join(resolvedRoot, 'secrets', 'vault.enc');
        if (fs.existsSync(vaultPath)) {
          const v = new Vault({ filePath: vaultPath, masterKey });
          const secret = v.get('openai_api_key');
          if (secret) return secret;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}

let cachedWorkingModel = null;
let lastModelCheck = 0;

/**
 * Resolusi model/combo AI upstream yang aktif dan valid (misal: Hermes-Tele).
 */
export async function resolveUpstreamModel(targetUrl, apiKey, requestedModel = null, rootDir = process.cwd()) {
  if (requestedModel && typeof requestedModel === 'string' && requestedModel.trim()) {
    return requestedModel.trim();
  }
  if (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim()) {
    return process.env.OPENAI_MODEL.trim();
  }

  // Cek langsung dari file .env jika belum ada di process.env
  try {
    const envFile = path.join(rootDir || process.cwd(), '.env');
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf8');
      const m = content.match(/^OPENAI_MODEL=(.+)$/m);
      if (m && m[1].trim()) return m[1].trim();
    }
  } catch {}

  const now = Date.now();
  if (cachedWorkingModel && now - lastModelCheck < 60_000) {
    return cachedWorkingModel;
  }

  try {
    const res = await fetch(`${targetUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
      if (models.includes('Hermes-VM')) {
        cachedWorkingModel = 'Hermes-VM';
        lastModelCheck = now;
        return 'Hermes-VM';
      }
      if (models.includes('Hermes-Tele')) {
        cachedWorkingModel = 'Hermes-Tele';
        lastModelCheck = now;
        return 'Hermes-Tele';
      }
      if (models.length > 0) {
        cachedWorkingModel = models[0];
        lastModelCheck = now;
        return models[0];
      }
    }
  } catch {}

  return 'Hermes-VM';
}

/**
 * Bangun system prompt profesional tingkat SRE untuk Hermes Agent.
 * Mendukung Dynamic Introspection agar agen terus beradaptasi dengan
 * perubahan arsitektur, adapter, dokumen, dan CLI tanpa perlu re-prompting.
 */
export function buildAgentSystemPrompt(metrics, servicesSummary, projectSummary = '', rootDir = process.cwd()) {
  const intro = introspectWorkspaceCapabilities(rootDir);
  const adapterList = intro.adapters.length > 0 ? intro.adapters.join(', ') : 'node, python, static';
  const cliSummary = Object.entries(intro.cliCommands)
    .map(([noun, verbs]) => `${noun}${verbs.length ? ` [${verbs.join('/')}]` : ''}`)
    .join(', ');
  const docsSummary = intro.docs.length > 0 ? intro.docs.join(', ') : 'DESIGN.md, ARCHITECTURE.md, AGENTS.md';
  const skillsSummary = intro.skills.length > 0 ? intro.skills.join(', ') : 'vm-panel';
  const rulesSummary = intro.rules.length > 0 ? intro.rules.join(' | ') : '100% Fresh | No Hardcoded Secret | No Secret Leak | Two-Phase Confirm';

  return (
    `Anda adalah **Hermes Agent**, Lead Site Reliability Engineer (SRE) dan Pengendali Otonom Infrastruktur Server untuk platform **VM-Panel**.\n\n` +
    `OTORITAS & KENDALI SISTEM:\n` +
    `Anda memiliki akses langsung dan kendali eksekutif terhadap seluruh subsistem VM-Panel melalui function calling tools yang disediakan.\n` +
    `Jika pengguna meminta pemeriksaan status, modifikasi service, pembuatan backup, deployment project, inspeksi log, atau investigasi insiden, PANGGIL TOOL YANG TEPAT SECARA OTONOM.\n\n` +
    `KAPABILITAS DINAMIS & INTROSPEKSI SISTEM REAL-TIME:\n` +
    `- Versi Platform: VM-Panel v${intro.version} | Host OS: ${metrics.host.platform} (${metrics.host.arch}) | Node.js ${metrics.host.nodeVersion}\n` +
    `- Adapters Runtime Terdeteksi: ${adapterList}\n` +
    `- Command CLI vmctl Terdeteksi: ${cliSummary}\n` +
    `- Skill Otonom Terpasang: ${skillsSummary}\n` +
    `- Dokumen Desain & Operasional (docs/): ${docsSummary}\n` +
    `- Aturan Kepatuhan Sistem (AGENTS.md): ${rulesSummary}\n\n` +
    `DOKTRIN CONTINUOUS ADAPTATION & ZERO RE-PROMPTING:\n` +
    `1. Anda adalah AI Agent otonom yang adaptif dan proaktif. Anda TIDAK bergantung pada asumsi statis atau prompt masa lalu.\n` +
    `2. Ketika subsistem, perintah CLI, adapter, atau fitur baru ditambahkan ke VM-Panel di masa depan:\n` +
    `   - Anda secara otomatis mengetahui komponen baru melalui blok telemetri dan tools introspeksi.\n` +
    `   - Jika pengguna menyebutkan fitur, modul, atau konsep baru yang belum ada di ringkasan, Anda WAJIB memanggil tool 'introspect_architecture', 'inspect_documentation', 'query_manager_route', atau 'execute_cli' untuk meneliti dan memverifikasi implementasi terbarunya secara mandiri.\n` +
    `3. DILARANG meminta pengguna memperkenalkan ulang VM-Panel, menjelaskan cara kerja project, atau mengedit prompt Anda. Semua informasi dapat Anda telusuri sendiri langsung dari kode sumber, dokumentasi, dan API internal.\n\n` +
    `STANDAR KELUARAN & GAYA KOMUNIKASI (SENIOR SRE):\n` +
    `1. DILARANG menggunakan kata pembuka klise chatbot santai ("Halo!", "Tentu saja!", "Saya siap membantu!").\n` +
    `2. DILARANG KERAS MENGGUNAKAN EMOJI DALAM BENTUK APA PUN. Jangan pernah menyertakan emoji seperti ⚡, 🚀, 🟢, 🔴, 🟡, ⚠️, 📦, 🧭, 🛠️, dsb. Gunakan penanda status tekstual standar dalam tanda kurung siku, contoh: [OK], [NORMAL], [RUNNING], [STOPPED], [WARN], [CRITICAL], [IDLE].\n` +
    `3. Mulai jawaban dengan heading Markdown ringkas dan elegan tanpa emoji, contoh: ### Status Sistem Host atau ### Laporan Operasional SRE.\n` +
    `4. Sajikan data dalam format ringkas (tabel Markdown ringkas 2-3 kolom, atau daftar poin tajam).\n` +
    `5. Sampaikan instruksi CLI teknis dalam blok kode terpisah, contoh: \`\`\`bash\nvmctl specs\n\`\`\`.\n` +
    `6. EFISIENSI & KEPADATAN TINGGI: Jaga jawaban tetap padat, terstruktur, dan tidak bertele-tele (maksimal 150-250 kata). Hindari dinding teks panjang agar antarmuka chat tetap rapi, compact, dan mudah dipindai.\n` +
    `7. PROFIL & IDENTITAS: Jika pengguna menanyakan siapa Anda, identitas, atau kapabilitas sistem: sajikan ringkasan dalam 1 paragraf padat, diikuti tabel Markdown ringkas 3 kolom (| Kategori Operasional | Ruang Lingkup | Hak Akses |) dengan hak akses menggunakan penanda teks [OK] atau [WARN] tanpa emoji apa pun.\n\n` +
    `PROTOKOL KESELAMATAN OPERASIONAL & TWO-PHASE CONFIRMATION (AGENTS.md Aturan 2, 3, 4):\n` +
    `- DILARANG mengeksekusi operasi destruktif (stop service produksi, hapus project/service, rollback deployment, purge backup, reset konfigurasi) tanpa konfirmasi eksplisit dari pengguna.\n` +
    `- Jika pengguna meminta operasi destruktif, berikan blok peringatan bahaya resmi dan tantangan konfirmasi dua tahap:\n` +
    `  > [!CAUTION]\n` +
    `  > **TINDAKAN BERDAMPAK TINGGI / DESTRUKTIF DITAHAN**\n` +
    `  > Operasi pada target \`<TARGET_ID>\` dapat menyebabkan downtime atau kehilangan data.\n` +
    `  > Untuk melanjutkan eksekusi, ketik secara eksplisit: \`KONFIRMASI <TARGET_ID>\`\n` +
    `- DILARANG mencetak token, kata sandi, private key, atau secret mentah ke dalam respons (AGENTS.md Aturan 3).\n\n` +
    `[TELEMETRI REAL-TIME HOST SAAT INI]\n` +
    `- Host OS: ${metrics.host.platform} (${metrics.host.arch}) | Node.js ${metrics.host.nodeVersion}\n` +
    `- CPU: ${metrics.cpu.model} (${metrics.cpu.cores} Cores) | Load: ${metrics.cpu.load1} (${metrics.cpu.loadPct}%)\n` +
    `- Memory: ${metrics.memory.usedMb.toLocaleString()} MB / ${metrics.memory.totalMb.toLocaleString()} MB (${metrics.memory.usedPct}% terpakai, free ${metrics.memory.freeMb.toLocaleString()} MB)\n` +
    (metrics.disk ? `- Storage Disk: ${metrics.disk.usedMb.toLocaleString()} MB / ${metrics.disk.totalMb.toLocaleString()} MB (${metrics.disk.usedPct}% terpakai, free ${metrics.disk.freeMb.toLocaleString()} MB)\n` : '') +
    `- Uptime: ${metrics.host.uptimeText}\n` +
    `- Port Web Panel: 8080 | Port Manager API: 8097\n` +
    `- Service Aktif Terdaftar:\n${servicesSummary}\n` +
    (projectSummary ? `- Project Terdaftar:\n${projectSummary}\n` : '')
  );
}

/**
 * Tangani permintaan chat dari client browser.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} [context]
 */
export function handleAssistantChat(req, res, context = {}) {
  return new Promise((resolve) => {
    let bodyStr = '';
    const run = async () => {
      let payload;
      try {
        payload = JSON.parse(bodyStr || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        resolve();
        return;
      }

      const { message, history = [], deployContext = null } = payload;
      if (!message || typeof message !== 'string' || message.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Field message wajib diisi' }));
        resolve();
        return;
      }

      // A2#15: deadline GLOBAL satu siklus chat — semua fetch upstream turn memakai
      // signal yang sama agar endpoint mati/lambat tak pernah menahan respons selamanya
      // (saat abort, try/catch di bawah jatuh ke fallback lokal). AbortSignal.timeout
      // memakai timer unref dan self-dispose — tidak butuh clearTimeout manual.
      const chatDeadline = AbortSignal.timeout(chatDeadlineMs());

      // Cek apakah ada instruksi spesifik konfigurasi deployment (hanya jika ada deployContext aktif)
      const deployIntent = deployContext ? detectDeployIntent(message, deployContext) : null;
      if (deployIntent && deployIntent.reply) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            reply: deployIntent.reply,
            source: 'hermes-copilot',
            action: deployIntent.action || null,
          })
        );
        resolve();
        return;
      }

      const status = await getAssistantStatus();
      const targetUrl = status.gatewayOnline && !context.forceLocal
        ? gatewayUrl()
        : status.routerOnline && !context.forceLocal
          ? routerUrl()
          : null;

      // JIKA INI SESI DEPLOYMENT CO-PILOT: Tangani secara terisolasi khusus project deployment
      if (deployContext) {
        const copilotSystemPrompt = buildDeployCopilotSystemPrompt(deployContext);
        // A2#16: history + pesan user dimask sebelum keluar ke upstream LLM.
        const copilotMessages = [
          { role: 'system', content: copilotSystemPrompt },
          ...maskMessages(history.slice(-8)),
          { role: 'user', content: maskEnvAssignments(message) },
        ];

        if (targetUrl) {
          try {
            const apiKey = resolveAssistantApiKey(context.rootDir) || 'sk-vm-panel-local';
            const modelName = await resolveUpstreamModel(targetUrl, apiKey, deployContext?.env?.OPENAI_MODEL);

            const requestPayload = {
              model: modelName,
              messages: copilotMessages,
              stream: false,
            };

            let upstream = await fetch(`${targetUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(requestPayload),
              signal: chatDeadline,
            });

            // Fallback retry jika model default gagal (503 / 429) ke combo Hermes-Tele
            if (!upstream.ok && (upstream.status === 503 || upstream.status === 429 || upstream.status === 404) && modelName !== 'Hermes-Tele') {
              try {
                const retryRes = await fetch(`${targetUrl}/chat/completions`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                  },
                  body: JSON.stringify({ ...requestPayload, model: 'Hermes-Tele' }),
                  signal: chatDeadline,
                });
                if (retryRes.ok) {
                  upstream = retryRes;
                  cachedWorkingModel = 'Hermes-Tele';
                }
              } catch {}
            }

            if (upstream.ok) {
              const rawText = await upstream.text();
              const data = safeParseLlmJson(rawText);
              const choice = data?.choices?.[0];
              const msg = choice?.message;
              let reply = msg?.content || choice?.delta?.content || null;
              if (reply) {
                reply = reply.replace(/<tool_call>[\s\S]*?<\/arg_value>/gi, '').trim();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    reply,
                    source: 'hermes-copilot',
                  })
                );
                resolve();
                return;
              }
            }
          } catch (err) {
            console.warn(`[assistant] Copilot upstream error: ${err.message}`);
          }
        }

        // Fallback lokal cerdas khusus Hermes Deployment Co-Pilot
        const localReply = generateDeployCopilotAnswer(message, deployContext);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            reply: localReply,
            source: 'hermes-copilot',
            action: null,
          })
        );
        resolve();
        return;
      }

      const metrics = collectHostMetrics();

      let servicesSummary = 'Belum ada service kustom terdaftar.';
      let projectSummary = '';
      if (typeof context.managerGet === 'function') {
        try {
          const resSvc = await context.managerGet('/services');
          const services = Array.isArray(resSvc) ? resSvc : resSvc?.services || resSvc?.rows || null;
          if (Array.isArray(services) && services.length > 0) {
            servicesSummary = services
              .map(
                (s) =>
                  `- ${s.name || s.id}: status=${s.status || 'running'}, port=${s.port || '-'}, tipe=${s.type || 'node'}`
              )
              .join('\n');
          }
        } catch {}
        try {
          const resProj = await context.managerGet('/projects');
          const projects = Array.isArray(resProj) ? resProj : resProj?.projects || resProj?.rows || null;
          if (Array.isArray(projects) && projects.length > 0) {
            projectSummary = projects
              .map((p) => `- ${p.name || p.id} (${p.type || 'node'}, port: ${p.port || '-'})`)
              .join('\n');
          }
        } catch {}
      }

      const agentSystemPrompt = buildAgentSystemPrompt(metrics, servicesSummary, projectSummary, context.rootDir);

      const messages = [
        { role: 'system', content: agentSystemPrompt },
      ];

      // A2#16: history + pesan user dimask sebelum keluar ke upstream LLM.
      messages.push(...maskMessages(history.slice(-10)));
      messages.push({ role: 'user', content: maskEnvAssignments(message) });

      if (targetUrl) {
        try {
          const apiKey = resolveAssistantApiKey(context.rootDir) || 'sk-vm-panel-local';
          const modelName = await resolveUpstreamModel(targetUrl, apiKey);

          let currentMessages = [...messages];
          const executedTools = [];
          const maxTurns = 3;

          for (let turn = 0; turn < maxTurns; turn++) {
            const hasExecutedTools = executedTools.length > 0;
            const isLastTurn = turn === maxTurns - 1 || hasExecutedTools;

            const requestPayload = {
              model: modelName,
              messages: currentMessages,
              tools: isLastTurn ? undefined : VM_PANEL_TOOLS,
              tool_choice: isLastTurn ? 'none' : 'auto',
              stream: false,
            };

            let upstream = await fetch(`${targetUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(requestPayload),
              signal: chatDeadline,
            });

            if (!upstream.ok && (upstream.status === 503 || upstream.status === 429 || upstream.status === 404) && modelName !== 'Hermes-Tele') {
              try {
                const retryRes = await fetch(`${targetUrl}/chat/completions`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                  },
                  body: JSON.stringify({ ...requestPayload, model: 'Hermes-Tele' }),
                  signal: chatDeadline,
                });
                if (retryRes.ok) {
                  upstream = retryRes;
                  cachedWorkingModel = 'Hermes-Tele';
                }
              } catch {}
            }

            if (!upstream.ok) {
              console.warn(`[assistant] Upstream ${targetUrl} returned status ${upstream.status}`);
              break;
            }

            const rawText = await upstream.text();
            const data = safeParseLlmJson(rawText);
            const choice = data?.choices?.[0];
            const msg = choice?.message;

            // Jika LLM memanggil Tools (Function Calling)
            if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0 && !hasExecutedTools) {
              currentMessages.push(msg);

              for (const tc of msg.tool_calls) {
                const fnName = tc.function?.name;
                executedTools.push(fnName);
                let fnArgs = {};
                try {
                  fnArgs = JSON.parse(tc.function?.arguments || '{}');
                } catch {
                  fnArgs = {};
                }
                const execResult = await executeVmPanelTool(fnName, fnArgs, context);
                currentMessages.push({
                  tool_call_id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  role: 'tool',
                  name: fnName,
                  content: JSON.stringify(execResult),
                });
              }

              // Minta sintesis eksekutif langsung pada giliran berikutnya
              currentMessages.push({
                role: 'system',
                content:
                  'Semua data dari tool telah berhasil diperoleh. Sekarang sajikan LAPORAN OPERASIONAL SRE EKSEKUTIF yang komprehensif, presisi, dan terstruktur dengan tabel Markdown berdasarkan data telemetri di atas tanpa memanggil tool lagi.',
              });

              continue;
            }

            let reply = msg?.content || choice?.delta?.content || null;
            if (reply) {
              // Bersihkan jika ada artefak sintaks pseudo-tool mentah yang tersisa
              reply = reply.replace(/<tool_call>[\s\S]*?<\/arg_value>/gi, '').trim();
              if (!reply) reply = msg?.content || '';

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  reply,
                  source: 'hermes-agent',
                  executedTools: executedTools.length > 0 ? executedTools : undefined,
                })
              );
              resolve();
              return;
            }
          }
        } catch (err) {
          console.warn(`[assistant] Upstream error: ${err.message}`);
        }
      }

      // Fallback lokal jika LLM offline atau mengalami gangguan jaringan
      if (deployContext && deployIntent && deployIntent.reply) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            reply: deployIntent.reply,
            source: 'hermes-copilot',
            action: deployIntent.action,
          })
        );
        resolve();
        return;
      }

      const intent = detectSystemIntent(message);
      const localReply = await generateLocalAnswer(intent, message, context);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          reply: localReply,
          source: 'hermes-local',
        })
      );
      resolve();
    };
    // Floating rejection di handler = res tidak pernah selesai (akibat hang bug
    // A2#15). Guard ini menjamin selalu ada respons + promise settle.
    const guard = (p) => {
      p.catch((err) => {
        console.warn(`[assistant] handler error: ${err?.message || err}`);
        if (!res.headersSent) {
          try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Kesalahan internal assistant' }));
          } catch {
            /* socket mati */
          }
        }
        resolve();
      });
    };
    if (context && context.payload !== undefined) {
      // A2#8: rute panel sudah membaca body via #readBody (batas 1MB) + validasi
      // CSRF/limit — jangan baca stream req dua kali; pakai payload siap.
      bodyStr = typeof context.payload === 'string' ? context.payload : JSON.stringify(context.payload);
      guard(run());
      return;
    }
    req.on('data', (chunk) => {
      bodyStr += chunk;
      if (bodyStr.length > 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => guard(run()));
  });
}

/**
 * Deteksi intent pengguna saat berinteraksi dengan Hermes selama sesi deployment
 * @param {string} message
 * @param {object} [deployContext]
 * @returns {object|null}
 */
export function detectDeployIntent(message, deployContext = null) {
  if (!message || typeof message !== 'string') return null;
  const msg = message.trim();

  // Jika pesan adalah pertanyaan informatif / panduan / penjelasan cara deploy, jangan trigger eksekusi
  const isQuestion = /(?:cara|bagaimana|jelaskan|panduan|tutorial|kenapa|mengapa|apakah|apa itu|bisa kah|\?)/i.test(msg);
  if (isQuestion) {
    // Kecuali jika eksplisit meminta analisis codebase / arsitektur
    if (!/(?:analisis|cek|periksa|arsitektur|apa yang kurang|rekomendasi)/i.test(msg)) {
      return null;
    }
  }

  // 1. Ubah / set port: e.g. "port 3005", "ganti port ke 3005", "set port 8080"
  const portMatch = msg.match(/(?:ubah|ganti|set|pindah|gunakan)?\s*port\s*(?:ke|menjadi|=|:)?\s*(\d{2,5})/i);
  if (portMatch) {
    const p = parseInt(portMatch[1], 10);
    if (p >= 1024 && p <= 65535) {
      return {
        type: 'set_port',
        port: p,
        reply: `Port deployment project berhasil disetel ke **${p}**. Port ini siap dialokasikan dan dipantau 24/7.`,
        action: { type: 'update_config', updates: { port: p } },
      };
    }
  }

  // 2. Set environment variable: e.g. "set BOT_TOKEN=xxx", "isi token BOT_TOKEN=123", "DATABASE_URL=postgres://..."
  const envMatch =
    msg.match(/(?:set|isi|tambah|tambahkan|atur)\s+(?:token|env|secret)?\s*([A-Za-z0-9_]+)\s*(?:=|adalah|ke|:)\s*([^\s]+)/i) ||
    msg.match(/^([A-Z0-9_]{3,})\s*=\s*([^\s]+)$/);
  if (envMatch) {
    const key = envMatch[1].trim().toUpperCase();
    const val = envMatch[2].trim();
    const isSecret = /TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH/i.test(key);
    const masked = isSecret && val.length > 8 ? `${val.slice(0, 4)}...${val.slice(-4)}` : val;
    return {
      type: 'set_env',
      key,
      value: val,
      reply: `Environment variable **${key}** berhasil dikonfigurasi (\`${masked}\`). Nilai ini akan disuntikkan secara aman ke workspace project saat proses build dijalankan.`,
      action: { type: 'update_config', updates: { env: { [key]: val } } },
    };
  }

  // 2b. Set 9Router Combo / Model: e.g. "gunakan combos bernama 'Hermes-Tele' di 9router", "pakai combo Hermes-Tele"
  const comboMatch =
    msg.match(/(?:gunakan|pakai|set|pilih|hubungkan)\s+(?:combos?|model)\s*(?:bernama|nama)?\s*["']?([a-zA-Z0-9_.-]+)["']?/i) ||
    msg.match(/(?:combo|combos)\s*(?:bernama|nama)?\s*["']?([a-zA-Z0-9_.-]+)["']?\s*(?:di|pada|ke)?\s*9router/i) ||
    msg.match(/9router\s+(?:pakai|dengan)?\s*(?:combo|combos|model)\s*["']?([a-zA-Z0-9_.-]+)["']?/i);
  if (comboMatch) {
    const comboName = comboMatch[1].trim();
    const routerPort = process.env.ROUTER_PORT || 20127;
    const routerBaseUrl = `http://127.0.0.1:${routerPort}/v1`;
    return {
      type: 'set_combo',
      combo: comboName,
      reply: `Konfigurasi 9Router berhasil diterapkan! Model/Combo disetel ke **${comboName}** dengan target endpoint 9Router (\`${routerBaseUrl}\`). Variabel \`OPENAI_BASE_URL\` dan \`OPENAI_MODEL\` otomatis disuntikkan ke konfigurasi deployment project ini.`,
      action: {
        type: 'update_config',
        updates: {
          env: {
            OPENAI_BASE_URL: routerBaseUrl,
            OPENAI_MODEL: comboName,
            MODEL: comboName,
            ROUTER_URL: routerBaseUrl,
          },
        },
      },
    };
  }

  // 3. Set project name: e.g. "nama project my-bot", "ganti nama ke cool-app"
  const nameMatch = msg.match(
    /(?:ubah|ganti|set)?\s*nama\s*(?:project|projek|bot|app)?\s*(?:ke|menjadi|=|:)?\s*([a-zA-Z0-9_-]{2,60})/i
  );
  if (nameMatch) {
    const newName = nameMatch[1].trim().toLowerCase();
    return {
      type: 'set_name',
      name: newName,
      reply: `Nama project berhasil diubah menjadi **${newName}**.`,
      action: { type: 'update_config', updates: { name: newName } },
    };
  }

  // 4. Trigger deploy: e.g. "deploy sekarang", "mulai deploy", "jalankan deploy", "gas deploy"
  // Harus berupa perintah eksekusi imperatif yang tegas (bukan pertanyaan 'cara deploy?')
  if (
    !isQuestion &&
    /^(?:ayo\s+|tolong\s+)?(?:mulai|jalankan|gas|lanjut|lakukan|start)?\s*deploy(?:\s+sekarang|\s+now)?$/i.test(msg)
  ) {
    return {
      type: 'trigger_deploy',
      reply: `Instruksi diterima! Memulai orkestrasi pipeline deployment untuk project **${deployContext?.projectName || 'aplikasi'}** sekarang. Memantau progres melalui live stream...`,
      action: { type: 'trigger_deploy' },
    };
  }

  // 5. Analisis arsitektur & kelengkapan config
  if (/(?:analisis|cek|periksa|arsitektur|apa yang kurang|rekomendasi|status)/i.test(msg) && deployContext) {
    if (deployContext.stage === 'error' || deployContext.error) {
      const err = deployContext.error || 'Tipe project belum dapat dikenali secara otomatis.';
      return {
        type: 'analysis_report',
        reply:
          `### [WARN] Analisis Codebase & Diagnostik Error\n\n` +
          `Codebase pada direktori \`${deployContext.folderPath || 'target'}\` belum berhasil diinspeksi secara lengkap:\n` +
          `> \`${err}\`\n\n` +
          `**Saran Perbaikan Hermes**:\n` +
          `1. Pastikan direktori memiliki file entrypoint seperti \`bot.py\`, \`main.py\`, \`app.py\`, \`index.js\`, atau \`package.json\`.\n` +
          `2. Jika project berada di subdirektori (misal \`src/\` atau \`backend/\`), Anda dapat memilih folder tersebut secara langsung.\n` +
          `3. Anda tetap dapat mengonfigurasi port atau environment variable dengan mengetik: \`ganti port ke <nomor>\` atau \`set BOT_TOKEN=xxx\`.`,
        action: null,
      };
    }

    const fw = deployContext.framework || 'Aplikasi Web/Bot';
    const entry = deployContext.entryFile || '-';
    const missingEnvs = (deployContext.detectedEnvs || [])
      .filter((e) => e.required && (!deployContext.env || !deployContext.env[e.key]))
      .map((e) => e.key);

    let report = `### [INFO] Analisis Codebase & Rekomendasi Hermes\n\n`;
    report += `| Komponen | Deteksi Real-Time | Status |\n`;
    report += `|---|---|---|\n`;
    report += `| **Framework** | \`${fw}\` | [OK] |\n`;
    report += `| **Entrypoint** | \`${entry}\` | [OK] |\n`;
    report += `| **Port Alokasi** | \`${deployContext.port || 'Auto'}\` | [READY] |\n\n`;

    if (missingEnvs.length > 0) {
      report += `[WARN] Ditemukan variabel lingkungan penting dalam kode sumber yang belum diisi:\n`;
      report += missingEnvs.map((k) => `- \`${k}\``).join('\n') + `\n\n`;
      report += `Ketik: \`set ${missingEnvs[0]}=<nilai_anda>\` untuk mengisinya sekarang.`;
    } else {
      report += `[READY] Semua konfigurasi tampak siap. Anda dapat mengklik tombol **Jalankan Deployment Sekarang** atau mengetik \`deploy sekarang\` untuk memulai proses.`;
    }

    return {
      type: 'analysis_report',
      reply: report,
      action: null,
    };
  }

  return null;
}

/**
 * Bangun system prompt khusus untuk Hermes Deployment Co-Pilot.
 * Fokus 100% pada codebase project yang sedang dideploy, bukan infrastruktur host VM-Panel.
 * @param {object} deployContext
 * @returns {string}
 */
export function buildDeployCopilotSystemPrompt(deployContext) {
  const fw = deployContext.framework || 'Aplikasi / Bot';
  const entry = deployContext.entryFile || '-';
  const port = deployContext.port || 'Auto';
  const stage = deployContext.stage || 'inspecting';
  const projName = deployContext.projectName || path.basename(deployContext.folderPath || 'Project');
  const detectedEnvs = (deployContext.detectedEnvs || [])
    .map((e) => `${e.key}${e.required ? ' (wajib)' : ''}`)
    .join(', ') || 'Tidak ada';
  const configuredEnvs = Object.keys(deployContext.env || {}).join(', ') || 'Belum ada';
  const errorInfo = deployContext.error ? `\n- Kendala Saat Ini: ${deployContext.error}` : '';

  return (
    `Anda adalah **Hermes Deployment Co-Pilot**, asisten AI khusus orkestrasi deployment di VM-Panel.\n\n` +
    `FOKUS & RUANG LINGKUP:\n` +
    `Tugas Anda adalah memandu dan membantu developer mendeploy project aplikasi/bot mereka dengan lancar.\n` +
    `Fokus 100% pada analisis codebase, konfigurasi environment variable, pemilihan port, dan kesiapan runtime project berikut:\n\n` +
    `[METADATA PROJECT TARGET]\n` +
    `- Nama Project: ${projName}\n` +
    `- Folder Path: ${deployContext.folderPath || '-'}\n` +
    `- Framework / Runtime: ${fw}\n` +
    `- Entrypoint File: ${entry}\n` +
    `- Port Alokasi: ${port}\n` +
    `- Status Pipeline: ${stage}\n` +
    `- Variabel Lingkungan Terdeteksi: ${detectedEnvs}\n` +
    `- Variabel Yang Sudah Dikonfigurasi: ${configuredEnvs}` +
    errorInfo +
    `\n\n` +
    `PEDOMAN KOMUNIKASI & OPERASI:\n` +
    `1. Jawab secara spesifik mengenai project ini. JANGAN mencampuradukkan analisis dengan arsitektur internal server VM-Panel v0.1.0 kecuali pengguna eksplisit menanyakannya.\n` +
    `2. DILARANG KERAS MENGGUNAKAN EMOJI DALAM BENTUK APA PUN. Gunakan penanda status tekstual standar dalam kurung siku, contoh: [OK], [WARN], [READY], [CONFIGURED], [ERROR].\n` +
    `3. Jika ada error inspeksi atau stage gagal, jelaskan kemungkinan penyebabnya secara teknis dan berikan solusi langkah demi langkah.\n` +
    `4. Berikan panduan perintah cepat jika pengguna ingin mengubah konfigurasi, misalnya:\n` +
    `   - Ganti port: \`ganti port ke <nomor_port>\`\n` +
    `   - Set env / token: \`set <KUNCI>=<nilai>\`\n` +
    `   - Jalankan deploy: \`deploy sekarang\`\n` +
    `5. Jaga jawaban tetap padat, terstruktur, dan elegan (maksimal 150-200 kata).`
  );
}

/**
 * Jawaban deterministik lokal untuk Hermes Deployment Co-Pilot
 * @param {string} message
 * @param {object} deployContext
 * @returns {string}
 */
export function generateDeployCopilotAnswer(message, deployContext = {}) {
  const rawMsg = (message || '').trim();
  const msg = rawMsg.toLowerCase();
  const projName = deployContext.projectName || path.basename(deployContext.folderPath || 'Project');
  const fw = deployContext.framework || 'Aplikasi Web/Bot';
  const entry = deployContext.entryFile || '-';
  const port = deployContext.port || 'Auto';

  // 1. Error / Failure Diagnostics
  if (deployContext.stage === 'error' || deployContext.error || /(?:error|gagal|kenapa|masalah|bantuan)/i.test(msg)) {
    const err = deployContext.error || 'Tipe project belum dapat dikenali secara otomatis.';
    return (
      `### [WARN] Diagnostik Deployment — ${projName}\n\n` +
      `Terjadi kendala pada tahap inspeksi codebase:\n` +
      `> \`${err}\`\n\n` +
      `**Saran Perbaikan Hermes**:\n` +
      `1. **Python**: Pastikan ada file entrypoint seperti \`bot.py\`, \`main.py\`, \`app.py\`, atau \`requirements.txt\`.\n` +
      `2. **Node.js**: Pastikan ada file script seperti \`index.js\`, \`bot.js\`, atau \`package.json\`.\n` +
      `3. **Static**: Pastikan ada file \`index.html\`.\n` +
      `4. Anda dapat menyetel port dan env langsung dengan mengetik:\n` +
      `   \`ganti port ke 3000\` atau \`set BOT_TOKEN=xxx\``
    );
  }

  // 2. Codebase Architecture & Config Analysis
  if (/(?:analisis|arsitektur|cek|periksa|status|rekomendasi)/i.test(msg)) {
    const missingEnvs = (deployContext.detectedEnvs || [])
      .filter((e) => e.required && (!deployContext.env || !deployContext.env[e.key]))
      .map((e) => e.key);

    let report = `### [INFO] Analisis Codebase — ${projName}\n\n`;
    report += `| Komponen | Deteksi Real-Time | Status |\n`;
    report += `|---|---|---|\n`;
    report += `| **Framework** | \`${fw}\` | [OK] |\n`;
    report += `| **Entrypoint** | \`${entry}\` | [OK] |\n`;
    report += `| **Target Port** | \`${port}\` | [READY] |\n\n`;

    if (missingEnvs.length > 0) {
      report += `[WARN] Ditemukan variabel lingkungan penting yang belum diisi:\n`;
      report += missingEnvs.map((k) => `- \`${k}\``).join('\n') + `\n\n`;
      report += `Ketik: \`set ${missingEnvs[0]}=<nilai>\` untuk menyetelnya langsung.`;
    } else {
      report += `[READY] Semua parameter siap. Klik **Jalankan Deployment Sekarang** atau ketik \`deploy sekarang\` untuk memulai.`;
    }
    return report;
  }

  // 3. Port / Token queries
  if (/(?:port)/i.test(msg)) {
    return (
      `### [INFO] Konfigurasi Port — ${projName}\n\n` +
      `Port aktif untuk deployment ini: **${port}**.\n\n` +
      `Untuk mengubahnya, ketik: \`ganti port ke <nomor_port>\` (misal: \`ganti port ke 3005\`).`
    );
  }

  // 3b. 9Router / Combos / LLM Model queries
  if (/(?:9router|combo|combos|model|llm)/i.test(msg)) {
    const currentBaseUrl = deployContext.env?.OPENAI_BASE_URL || deployContext.env?.ROUTER_URL || null;
    const currentModel = deployContext.env?.OPENAI_MODEL || deployContext.env?.MODEL || null;
    const askedComboMatch = rawMsg.match(/(?:combos?|model)\s*(?:bernama|nama)?\s*["']?([a-zA-Z0-9_.-]+)["']?/i) ||
      rawMsg.match(/["']([a-zA-Z0-9_.-]+)["']/);
    const askedCombo = askedComboMatch ? askedComboMatch[1] : 'Hermes-Tele';

    if (currentModel && currentModel.toLowerCase() === askedCombo.toLowerCase() && currentBaseUrl) {
      return (
        `### [OK] Status Konfigurasi 9Router — ${projName}\n\n` +
        `**SUDAH TERKONFIGURASI.** Project **${projName}** saat ini sudah dikonfigurasi menggunakan combo **${currentModel}** dari 9Router:\n\n` +
        `- **OPENAI_BASE_URL**: \`${currentBaseUrl}\`\n` +
        `- **OPENAI_MODEL**: \`${currentModel}\`\n\n` +
        `Semua variabel sudah terpasang dan siap digunakan saat deployment.`
      );
    }

    return (
      `### [STATUS] Konfigurasi 9Router — ${projName}\n\n` +
      `**BELUM TERPASANG.** Saat ini project **${projName}** belum dikonfigurasi dengan combo **${askedCombo}** dari 9Router.\n\n` +
      `Nilai variabel saat ini:\n` +
      `- **OPENAI_BASE_URL**: \`${currentBaseUrl || '(belum disetel)'}\`\n` +
      `- **OPENAI_MODEL**: \`${currentModel || '(belum disetel)'}\`\n\n` +
      `**Cara Mengaktifkannya:**\n` +
      `Ketik instruksi imperatif berikut ke saya:\n` +
      `> \`gunakan combo "${askedCombo}" di 9router\`\n\n` +
      `Saya akan otomatis menyuntikkan \`OPENAI_BASE_URL=http://127.0.0.1:20127/v1\` dan \`OPENAI_MODEL=${askedCombo}\` ke form deployment ini.`
    );
  }

  if (/(?:token|secret|env|variabel)/i.test(msg)) {
    const envs = deployContext.detectedEnvs || [];
    if (envs.length === 0) {
      return (
        `### [INFO] Status Environment — ${projName}\n\n` +
        `Tidak ada variabel lingkungan atau secret wajib yang terdeteksi. Project siap dideploy langsung.`
      );
    }
    let list = `### [INFO] Status Environment & Token — ${projName}\n\n`;
    for (const e of envs) {
      const isSet = deployContext.env && deployContext.env[e.key];
      list += `- \`${e.key}\`: ${isSet ? '[TERISI]' : e.required ? '[WAJIB]' : '[OPSIONAL]'}\n`;
    }
    list += `\nUntuk mengisi, ketik: \`set <NAMA_VARIABLE>=<nilai>\`.`;
    return list;
  }

  // 4. Default guidance
  return (
    `### Hermes Deployment Co-Pilot — ${projName}\n\n` +
    `Saya memandu deployment project **${projName}** (\`${fw}\`):\n\n` +
    `- **Analisis Proyek**: Ketik \`analisis kode\`\n` +
    `- **Ganti Port**: Ketik \`ganti port ke 3005\`\n` +
    `- **Set Token / Env**: Ketik \`set BOT_TOKEN=xxx\`\n` +
    `- **Mulai Deploy**: Ketik \`deploy sekarang\``
  );
}
