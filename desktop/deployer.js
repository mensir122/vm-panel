// desktop/deployer.js — Folder inspection & Drag-and-Drop auto-deployment.
// ESM module, Node >= 20.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export const RESERVED_PORTS = Object.freeze([8080, 8097, 20127, 20128]);
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

// Folder & file names that should NOT be copied from local source to workspace
const IGNORED_ENTRIES = new Set([
  'node_modules',
  '.git',
  '.github',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'env',
  '.idea',
  '.vscode',
  '.DS_Store',
  'Thumbs.db',
  '.cache',
  'cache',
  'audio_cache',
  'image_cache',
  'logs',
  'runtime',
  'sessions',
  'memories',
  'sandboxes',
  'kanban',
  '.system_generated',
  '.tempmediaStorage',
  '.hermes-runtime',
  'coverage',
  '.nyc_output',
]);

/**
 * Sanitize any raw string or folder name into a valid VM-Panel project name:
 * [a-z0-9][a-z0-9-]{1,62}
 */
export function sanitizeProjectName(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'project-' + Date.now().toString(36);
  let s = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (s.length === 0) s = 'app';
  if (s.length === 1) s = s + '-app';
  if (s.length > 63) s = s.slice(0, 63).replace(/-+$/, '');
  if (!NAME_RE.test(s)) s = 'prj-' + s.slice(0, 58);
  return s;
}

/**
 * Check if a port can be bound on 127.0.0.1 right now.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portBindTest(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => {
      try { srv.close(); } catch { /* noop */ }
      resolve(false);
    });
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Find the next available safe port.
 * @param {object} [opts]
 * @param {number[]} [opts.usedPorts]
 * @param {number} [opts.startPort]
 * @returns {Promise<number>}
 */
export async function allocateSafePort({ usedPorts = [], startPort = 10001 } = {}) {
  const usedSet = new Set([...RESERVED_PORTS, ...usedPorts]);
  for (let p = startPort; p <= 65535; p++) {
    if (usedSet.has(p)) continue;
    const canBind = await portBindTest(p);
    if (canBind) return p;
  }
  throw new Error('Tidak ada port legal yang tersedia di host ini (10001-65535)');
}

/**
 * Inspect a local project folder and identify its runtime type and metadata.
 * @param {string} folderPath
 * @returns {{
 *   type: 'node'|'python'|'static',
 *   suggestedName: string,
 *   entryFile: string|null,
 *   details: object
 * }}
 */
/**
 * Check if directory is a Hermes AI Agent project.
 */
export function isHermesAgentProject(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'hermes.bat')) || fs.existsSync(path.join(dir, 'bin', 'hermes.exe'))) {
      return true;
    }
    if (fs.existsSync(path.join(dir, 'hermes_cli')) || fs.existsSync(path.join(dir, 'hermes-agent'))) {
      return true;
    }
    if (fs.existsSync(path.join(dir, 'config.yaml'))) {
      const content = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8');
      if (/hermes|model\./i.test(content)) return true;
    }
  } catch {}
  return false;
}

const NON_ENTRY_PY_PATTERNS = [
  /^test/i,
  /_test\.py$/i,
  /^conftest\.py$/i,
  /^setup\.py$/i,
  /^build\.py$/i,
  /^bench/i,
  /^eval/i,
  /^seed\.py$/i,
  /^migrate/i,
  /^alembic/i,
  /^format\.py$/i,
  /^lint\.py$/i,
  /__init__\.py$/i,
];

const NON_ENTRY_JS_PATTERNS = [
  /\.test\.(js|mjs|cjs)$/i,
  /\.spec\.(js|mjs|cjs)$/i,
  /^test\.(js|mjs|cjs)$/i,
  /\.config\.(js|mjs|cjs)$/i,
  /^setup\.(js|mjs|cjs)$/i,
  /^build\.(js|mjs|cjs)$/i,
];

/**
 * Pick best Python entry script based on filename priority.
 */
function pickBestPyEntry(pyFiles) {
  if (!pyFiles || pyFiles.length === 0) return 'main.py';
  const filtered = pyFiles.filter((f) => !NON_ENTRY_PY_PATTERNS.some((p) => p.test(f.name)));
  const candidates = filtered.length > 0 ? filtered : pyFiles;
  const priority = [
    /^main\.py$/i,
    /^bot\.py$/i,
    /^telegram_bot\.py$/i,
    /^app\.py$/i,
    /^server\.py$/i,
    /^gateway\.py$/i,
    /^run\.py$/i,
    /^start\.py$/i,
    /^hermes\.py$/i,
    /^client\.py$/i,
    /^index\.py$/i,
    /^__main__\.py$/i,
    /^cli\.py$/i,
  ];
  for (const pat of priority) {
    const match = candidates.find((f) => f.depth === 0 && pat.test(f.name));
    if (match) return match.rel;
  }
  for (const pat of priority) {
    const match = candidates.find((f) => pat.test(f.name));
    if (match) return match.rel;
  }
  const sorted = [...candidates].sort((a, b) => a.depth - b.depth);
  return sorted[0].rel;
}

/**
 * Pick best Node.js entry script based on filename priority.
 */
function pickBestJsEntry(jsFiles) {
  if (!jsFiles || jsFiles.length === 0) return 'index.js';
  const filtered = jsFiles.filter((f) => !NON_ENTRY_JS_PATTERNS.some((p) => p.test(f.name)));
  const candidates = filtered.length > 0 ? filtered : jsFiles;
  const priority = [
    /^bot\.(js|mjs)$/i,
    /^index\.(js|mjs)$/i,
    /^server\.(js|mjs)$/i,
    /^app\.(js|mjs)$/i,
    /^main\.(js|mjs)$/i,
    /^start\.(js|mjs)$/i,
    /^run\.(js|mjs)$/i,
  ];
  for (const pat of priority) {
    const match = candidates.find((f) => f.depth === 0 && pat.test(f.name));
    if (match) return match.rel;
  }
  for (const pat of priority) {
    const match = candidates.find((f) => pat.test(f.name));
    if (match) return match.rel;
  }
  const sorted = [...candidates].sort((a, b) => a.depth - b.depth);
  return sorted[0].rel;
}

/**
 * Patterns of sensitive secret/credential files to never leak into git bridges.
 */
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\.|$)/i, // .env, .env.local, .env.production (kecuali .env.example)
  /\.(pem|key|pfx|p12|pkcs12)$/i, // Private keys & certs
  /^id_(rsa|dsa|ecdsa|ed25519)/i, // SSH keys
  /^(service[-_]?account.*|credentials.*|client[-_]?secret.*|token.*)\.json$/i, // Cloud credentials
];

/**
 * Check if a filename matches known sensitive credentials/tokens.
 * @param {string} filename
 * @returns {boolean}
 */
export function isSensitiveFile(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.toLowerCase().endsWith('.example')) return false;
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(filename));
}

/**
 * Sanitize and clean repository URL:
 * - Strips embedded tokens/credentials (e.g. https://token@github.com/user/repo)
 * - Converts SCP-style SSH (git@github.com:user/repo.git) to https://
 * - Strips trailing .git
 * @param {string} raw
 * @returns {string|null}
 */
export function cleanRepoUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u = raw.trim();
  if (!u) return null;

  // Handle scp-style git SSH (e.g. git@github.com:user/repo.git)
  const scpMatch = u.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    u = `https://${scpMatch[1]}/${scpMatch[2]}`;
  } else if (u.startsWith('git+https://')) {
    u = u.slice(4);
  } else if (u.startsWith('git+http://')) {
    u = u.slice(4);
  }

  // Strip trailing .git
  u = u.replace(/\.git$/i, '');

  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      // Strip any credentials (tokens, usernames, passwords)
      parsed.username = '';
      parsed.password = '';
      u = parsed.toString().replace(/\/+$/, '');
      if (u.endsWith('.git')) u = u.slice(0, -4);
    }
  } catch {
    u = u.replace(/^https?:\/\/[^@]+@/i, 'https://');
  }

  return u || null;
}


/**
 * Detect Git remote origin URL and branch from local .git folder.
 * @param {string} folderPath
 * @returns {{ repoUrl: string|null, branch: string }|null}
 */
export function detectFolderGitInfo(folderPath) {
  try {
    const gitDir = path.join(folderPath, '.git');
    if (!fs.existsSync(gitDir)) return null;

    let repoUrl = null;
    let branch = 'main';

    // 1. Read .git/HEAD for branch
    const headPath = path.join(gitDir, 'HEAD');
    if (fs.existsSync(headPath)) {
      const headContent = fs.readFileSync(headPath, 'utf8').trim();
      const m = headContent.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (m && m[1]) branch = m[1].trim();
    }

    // 2. Read .git/config for remote origin url
    const configPath = path.join(gitDir, 'config');
    if (fs.existsSync(configPath)) {
      const cfg = fs.readFileSync(configPath, 'utf8');
      const originMatch = cfg.match(/\[remote\s+["']origin["']\][^\[]*?url\s*=\s*([^\r\n]+)/is);
      if (originMatch && originMatch[1]) {
        repoUrl = cleanRepoUrl(originMatch[1]);
      }
    }

    return { repoUrl, branch };
  } catch {
    return null;
  }
}

/**
 * Detect repository URL from package.json if present.
 * @param {string} folderPath
 * @returns {string|null}
 */
export function detectPackageRepoUrl(folderPath) {
  try {
    const pkgPath = path.join(folderPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.repository === 'string') {
        let u = pkg.repository.trim();
        if (u.startsWith('github:')) u = 'https://github.com/' + u.slice(7);
        return cleanRepoUrl(u);
      } else if (pkg.repository && typeof pkg.repository.url === 'string') {
        let u = pkg.repository.url.trim().replace(/^git\+/, '');
        return cleanRepoUrl(u);
      }
    }
  } catch {}
  return null;
}

/**
 * Inspect a local project folder and identify its runtime type and metadata.
 * Deeply scans manifests and source code files up to 3 levels deep.
 * @param {string} folderPath
 * @returns {{
 *   type: 'node'|'python'|'static',
 *   suggestedName: string,
 *   entryFile: string|null,
 *   details: object
 * }}
 */
export function inspectProjectFolder(folderPath) {
  if (!folderPath || typeof folderPath !== 'string') {
    throw new Error('Path folder wajib berupa string.');
  }

  const resolved = path.resolve(folderPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Direktori tidak ditemukan: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Path bukan direktori: ${resolved}`);
  }

  const baseFolder = path.basename(resolved);
  let suggestedName = sanitizeProjectName(baseFolder);

  // 1. Direct check for Hermes AI Agent project
  if (isHermesAgentProject(resolved)) {
    return {
      type: 'python',
      suggestedName,
      entryFile: 'main.py',
      details: {
        isHermesAgent: true,
      },
    };
  }

  // 1b. Direct root check for package.json (fast path & canonical)
  const rootPkgPath = path.join(resolved, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    } catch (e) {
      throw new Error(`File package.json korup atau bukan JSON valid: ${e.message}`);
    }

    if (pkg.name && typeof pkg.name === 'string') {
      suggestedName = sanitizeProjectName(pkg.name);
    }

    const main = pkg.main || (fs.existsSync(path.join(resolved, 'index.js')) ? 'index.js' : 'server.js');
    return {
      type: 'node',
      suggestedName,
      entryFile: main,
      details: {
        scripts: pkg.scripts || {},
        dependencies: Object.keys(pkg.dependencies || {}),
        description: pkg.description || '',
      },
    };
  }

  // 2. Recursive file discovery up to depth 3
  const pyFiles = [];
  const jsFiles = [];
  const htmlFiles = [];
  const pkgFiles = [];
  const pyManifests = [];
  let totalEntries = 0;

  function discover(dir, depth = 0) {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (IGNORED_ENTRIES.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(resolved, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        discover(full, depth + 1);
      } else if (ent.isFile()) {
        totalEntries++;
        const lower = ent.name.toLowerCase();
        if (lower === 'package.json') {
          pkgFiles.push({ full, rel, depth });
        } else if (
          lower === 'requirements.txt' ||
          lower === 'pyproject.toml' ||
          lower === 'pipfile' ||
          lower === 'setup.py' ||
          lower === 'environment.yml'
        ) {
          pyManifests.push({ full, rel, depth });
        } else if (/\.pyw?$/i.test(lower)) {
          pyFiles.push({ full, rel, depth, name: ent.name });
        } else if (/\.(js|mjs|cjs|ts)$/i.test(lower)) {
          jsFiles.push({ full, rel, depth, name: ent.name });
        } else if (/\.(html|htm)$/i.test(lower)) {
          htmlFiles.push({ full, rel, depth, name: ent.name });
        }
      }
    }
  }

  discover(resolved, 0);

  // Subfolder package.json found
  if (pkgFiles.length > 0) {
    pkgFiles.sort((a, b) => a.depth - b.depth);
    const bestPkg = pkgFiles[0];
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(bestPkg.full, 'utf8'));
    } catch {
      pkg = {};
    }
    if (pkg.name && typeof pkg.name === 'string') {
      suggestedName = sanitizeProjectName(pkg.name);
    }
    const pkgDir = path.dirname(bestPkg.full);
    let main = pkg.main;
    const candidates = ['index.js', 'bot.js', 'server.js', 'app.js', 'main.js', 'index.mjs'];
    const foundJs = (main && fs.existsSync(path.join(pkgDir, main)))
      ? main
      : candidates.find((c) => fs.existsSync(path.join(pkgDir, c)));
    const hasJsStart = Boolean(pkg.scripts && (pkg.scripts.start || pkg.scripts.dev || pkg.scripts.bot));

    // If subfolder package.json has NO runnable JS entrypoint or script, but Python manifests/files exist, defer to Python
    if (foundJs || hasJsStart || (pyManifests.length === 0 && pyFiles.length === 0)) {
      main = foundJs || (pkg.main || 'index.js');
      const entryRel = path.relative(resolved, path.join(pkgDir, main)).replace(/\\/g, '/');
      return {
        type: 'node',
        suggestedName,
        entryFile: entryRel,
        details: {
          scripts: pkg.scripts || {},
          dependencies: Object.keys(pkg.dependencies || {}),
          description: pkg.description || '',
          subDir: path.relative(resolved, pkgDir).replace(/\\/g, '/') || null,
        },
      };
    }
  }

  // Python manifests found
  if (pyManifests.length > 0) {
    const entry = pickBestPyEntry(pyFiles);
    return {
      type: 'python',
      suggestedName,
      entryFile: entry,
      details: {
        hasRequirements: pyManifests.some((m) => m.rel.toLowerCase().endsWith('requirements.txt')),
        manifest: pyManifests[0].rel,
      },
    };
  }

  // Python files found (even without requirements.txt)
  if (
    pyFiles.length > 0 &&
    (pyFiles.length >= jsFiles.length || pyFiles.some((f) => /bot|telegram|main|app|run|hermes/i.test(f.name)))
  ) {
    const entry = pickBestPyEntry(pyFiles);
    return {
      type: 'python',
      suggestedName,
      entryFile: entry,
      details: {
        hasRequirements: false,
        pyFilesCount: pyFiles.length,
      },
    };
  }

  // Node.js files found without package.json
  if (jsFiles.length > 0) {
    const entry = pickBestJsEntry(jsFiles);
    return {
      type: 'node',
      suggestedName,
      entryFile: entry,
      details: {
        scripts: {},
        dependencies: [],
        jsFilesCount: jsFiles.length,
      },
    };
  }

  // Static web (index.html or any html file)
  if (htmlFiles.length > 0) {
    htmlFiles.sort((a, b) => a.depth - b.depth);
    const rootIndex = htmlFiles.find((h) => h.rel.toLowerCase() === 'index.html');
    const entry = rootIndex ? rootIndex.rel : htmlFiles[0].rel;
    return {
      type: 'static',
      suggestedName,
      entryFile: entry,
      details: {
        hasIndexHtml: true,
      },
    };
  }

  // Generic fallback if files exist in the directory
  if (totalEntries > 0) {
    const isPy = /py|python|django|flask|tele|bot/i.test(baseFolder);
    const chosenType = isPy ? 'python' : 'node';
    const chosenEntry = isPy ? 'main.py' : 'index.js';
    return {
      type: chosenType,
      suggestedName,
      entryFile: chosenEntry,
      details: {
        fallback: true,
        totalFiles: totalEntries,
      },
    };
  }

  throw new Error(
    'Tipe project tidak dikenali. Pastikan direktori memiliki package.json / file .js (Node.js), requirements.txt / file .py (Python), atau file .html (Static Web).'
  );
}

/**
 * Deep inspection of project folder: scans source files for environment variable
 * references, specific framework signatures, and recommended operational parameters.
 * @param {string} folderPath
 * @returns {object}
 */
export function deepInspectProjectFolder(folderPath) {
  const baseInspection = inspectProjectFolder(folderPath);
  const resolved = path.resolve(folderPath);

  const envsFound = new Map();
  let framework =
    baseInspection.type === 'node'
      ? 'Node.js Application'
      : baseInspection.type === 'python'
        ? 'Python Application'
        : 'Static Web';
  let totalFiles = 0;
  let totalBytes = 0;

  const SYSTEM_ENVS = new Set([
    'NODE_ENV',
    'PATH',
    'PWD',
    'HOME',
    'USER',
    'HOSTNAME',
    'SHELL',
    'TERM',
    'SHLVL',
    'LANG',
    'CI',
    'TZ',
    'EDITOR',
    'TMPDIR',
  ]);

  // Track framework matches by inspecting file contents
  const frameworkHits = new Set();

  function scanDir(currentDir, depth) {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (IGNORED_ENTRIES.has(ent.name)) continue;
      const full = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        scanDir(full, depth + 1);
      } else if (ent.isFile()) {
        totalFiles++;
        try {
          const st = fs.statSync(full);
          totalBytes += st.size;

          // Check env example/sample files
          if (
            /^\.env(\.(example|sample|template|local|dev|test))?$/i.test(ent.name) ||
            /^(config\.example\.json|example\.env)$/i.test(ent.name)
          ) {
            const content = fs.readFileSync(full, 'utf8');
            const lines = content.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
              if (match) {
                const varName = match[1];
                if (!SYSTEM_ENVS.has(varName)) {
                  envsFound.set(varName, {
                    key: varName,
                    defaultValue: match[2].trim(),
                    source: ent.name,
                    required: true,
                  });
                }
              }
            }
          }

          // Scan source code and package files up to 512KB
          if (
            st.size <= 512 * 1024 &&
            (/\.(js|mjs|cjs|ts|py|json|toml|txt|ya?ml)$/i.test(ent.name) || ent.name.toLowerCase() === 'requirements.txt')
          ) {
            const content = fs.readFileSync(full, 'utf8');

            // 1. Node.js process.env
            const nodeMatches = content.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g);
            for (const m of nodeMatches) {
              const varName = m[1] || m[2];
              if (varName && !SYSTEM_ENVS.has(varName) && !envsFound.has(varName)) {
                envsFound.set(varName, { key: varName, source: ent.name, required: varName !== 'PORT' });
              }
            }

            // 2. Python os.environ / os.getenv / decouple config / env('KEY')
            const pyMatches = content.matchAll(
              /(?:os\.environ\.get|os\.getenv|config|env)\(['"]([A-Z0-9_]+)['"]\)|os\.environ\['([A-Z0-9_]+)'\]/g
            );
            for (const m of pyMatches) {
              const varName = m[1] || m[2];
              if (varName && !SYSTEM_ENVS.has(varName) && !envsFound.has(varName)) {
                envsFound.set(varName, { key: varName, source: ent.name, required: varName !== 'PORT' });
              }
            }

            // 3. Framework content signatures
            const lowerContent = content.toLowerCase();
            if (lowerContent.includes('telegraf')) frameworkHits.add('telegraf');
            if (lowerContent.includes('grammy')) frameworkHits.add('grammy');
            if (lowerContent.includes('node-telegram-bot-api')) frameworkHits.add('node-telegram-bot-api');
            if (lowerContent.includes('discord.js')) frameworkHits.add('discord.js');
            if (lowerContent.includes('aiogram')) frameworkHits.add('aiogram');
            if (lowerContent.includes('telebot') || lowerContent.includes('pytelegrambotapi')) frameworkHits.add('telebot');
            if (lowerContent.includes('python-telegram-bot') || lowerContent.includes('telegram.ext')) frameworkHits.add('python-telegram-bot');
            if (lowerContent.includes('telethon')) frameworkHits.add('telethon');
            if (lowerContent.includes('pyrogram')) frameworkHits.add('pyrogram');
            if (lowerContent.includes('fastapi')) frameworkHits.add('fastapi');
            if (lowerContent.includes('flask')) frameworkHits.add('flask');
            if (lowerContent.includes('django')) frameworkHits.add('django');
            if (lowerContent.includes('express')) frameworkHits.add('express');
            if (lowerContent.includes('fastify')) frameworkHits.add('fastify');
            if (lowerContent.includes('next')) frameworkHits.add('next');
            if (lowerContent.includes('hono')) frameworkHits.add('hono');
            if (lowerContent.includes('socket.io')) frameworkHits.add('socket.io');
          }
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  }

  scanDir(resolved, 0);

  // Framework resolution
  if (baseInspection.type === 'node') {
    const deps = new Set(baseInspection.details?.dependencies || []);
    const scripts = baseInspection.details?.scripts || {};
    if (deps.has('telegraf') || frameworkHits.has('telegraf')) framework = 'Telegraf (Telegram Bot)';
    else if (deps.has('grammy') || frameworkHits.has('grammy')) framework = 'GrammY (Telegram Bot)';
    else if (deps.has('discord.js') || frameworkHits.has('discord.js')) framework = 'Discord.js (Discord Bot)';
    else if (deps.has('node-telegram-bot-api') || frameworkHits.has('node-telegram-bot-api')) framework = 'Node Telegram Bot';
    else if (deps.has('express') || frameworkHits.has('express')) framework = 'Express.js (REST API)';
    else if (deps.has('fastify') || frameworkHits.has('fastify')) framework = 'Fastify (High Performance API)';
    else if (deps.has('next') || frameworkHits.has('next')) framework = 'Next.js (Fullstack App)';
    else if (deps.has('hono') || frameworkHits.has('hono')) framework = 'Hono (Lightweight API)';
    else if (deps.has('socket.io') || frameworkHits.has('socket.io')) framework = 'Socket.io (Realtime Server)';
    else if (scripts.start && scripts.start.includes('bot')) framework = 'Node.js Bot Service';
    else if (/telegram|bot/i.test(path.basename(resolved))) framework = 'Telegram Bot (Node.js)';
  } else if (baseInspection.type === 'python') {
    if (baseInspection.details?.isHermesAgent || isHermesAgentProject(resolved)) framework = 'Hermes AI Agent (Telegram / Multi-Platform)';
    else if (frameworkHits.has('aiogram')) framework = 'Aiogram (Telegram Bot)';
    else if (frameworkHits.has('telebot')) framework = 'pyTelegramBotAPI (Telegram Bot)';
    else if (frameworkHits.has('python-telegram-bot')) framework = 'python-telegram-bot (Telegram Bot)';
    else if (frameworkHits.has('telethon')) framework = 'Telethon (Telegram MTProto Client/Bot)';
    else if (frameworkHits.has('pyrogram')) framework = 'Pyrogram (Telegram Bot)';
    else if (frameworkHits.has('fastapi')) framework = 'FastAPI (Python Web API)';
    else if (frameworkHits.has('flask')) framework = 'Flask (Python Web App)';
    else if (frameworkHits.has('django')) framework = 'Django (Fullstack Python)';
    else if (/telegram|bot/i.test(path.basename(resolved))) framework = 'Telegram Bot (Python)';
  }

  // Ensure common bot tokens are detected if it's a telegram bot
  if (framework.includes('Telegram') && !envsFound.has('BOT_TOKEN') && !envsFound.has('TELEGRAM_BOT_TOKEN')) {
    envsFound.set('BOT_TOKEN', {
      key: 'BOT_TOKEN',
      source: 'framework-signature',
      required: true,
      defaultValue: '',
    });
  }

  const detectedEnvs = Array.from(envsFound.values()).map((item) => {
    const k = item.key;
    let type = 'config';
    if (
      k.includes('TOKEN') ||
      k.includes('KEY') ||
      k.includes('SECRET') ||
      k.includes('PASSWORD') ||
      k.includes('PASS') ||
      k.includes('AUTH')
    ) {
      type = 'secret';
    } else if (
      k.includes('DATABASE') ||
      k.includes('DB_') ||
      k.includes('MONGO') ||
      k.includes('REDIS') ||
      k.includes('POSTGRES')
    ) {
      type = 'database';
    } else if (k === 'PORT') {
      type = 'port';
    }
    return {
      ...item,
      type,
    };
  });

  const gitInfo = detectFolderGitInfo(resolved) || {};
  const packageRepo = detectPackageRepoUrl(resolved);
  const detectedRepoUrl = gitInfo.repoUrl || packageRepo || null;
  const detectedBranch = gitInfo.branch || 'main';

  return {
    ...baseInspection,
    framework,
    totalFiles,
    totalBytes,
    detectedEnvs,
    gitInfo: {
      repoUrl: detectedRepoUrl,
      branch: detectedBranch,
    },
  };
}

/**
 * Copy directory recursively, ignoring node_modules, .git, and virtual environments.
 * @param {string} src
 * @param {string} dest
 * @param {object} [opts]
 * @param {boolean} [opts.ignoreEnv]
 */
export function copyWorkspaceFiles(src, dest, { ignoreEnv = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    // A2#23: symlink SELALU dilewati — mengikuti link membuka baca-file di
    // luar workspace (mis. C:\Windows\...) dan potensi link loop.
    if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
    if (ignoreEnv && isSensitiveFile(entry.name)) {
      continue;
    }

    // Abaikan dist/build KECUALI bila berisi index.html (artefak static build seperti Vite/React/Vue)
    if (entry.isDirectory() && (entry.name === 'dist' || entry.name === 'build')) {
      const hasIndex = fs.existsSync(path.join(src, entry.name, 'index.html'));
      if (!hasIndex) continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyWorkspaceFiles(srcPath, destPath, { ignoreEnv });
    } else if (entry.isFile()) {
      if (
        entry.name.endsWith('.db') ||
        entry.name.endsWith('.sqlite') ||
        entry.name.endsWith('.db-shm') ||
        entry.name.endsWith('.db-wal') ||
        entry.name.endsWith('.lock') ||
        entry.name.endsWith('.log') ||
        entry.name.endsWith('.pid')
      ) {
        continue;
      }
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Upsert environment variables into a .env file without duplicates.
 * Updates matching keys in-place and appends new keys.
 * @param {string} envFilePath
 * @param {object} envEntries
 */
export function upsertEnvFile(envFilePath, envEntries) {
  // A2#25: key wajib berbentuk identifier env; value strip \r\n agar satu
  // nilai tidak bisa menyuntik baris .env tambahan (injeksi KEY=danger).
  const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const entries = Object.entries(envEntries || {})
    .filter(([k]) => typeof k === 'string' && KEY_RE.test(k))
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => [k, String(v).replace(/[\r\n]+/g, ' ')]);
  if (entries.length === 0) return;

  const map = new Map(entries);
  let content = '';
  try {
    if (fs.existsSync(envFilePath)) {
      content = fs.readFileSync(envFilePath, 'utf8');
    }
  } catch {}

  const lines = content.split(/\r?\n/);
  const updatedLines = [];
  const processedKeys = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      updatedLines.push(line);
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (match) {
      const key = match[1];
      if (map.has(key)) {
        updatedLines.push(`${key}=${String(map.get(key))}`);
        processedKeys.add(key);
      } else {
        updatedLines.push(line);
      }
    } else {
      updatedLines.push(line);
    }
  }

  for (const [k, v] of map) {
    if (!processedKeys.has(k)) {
      updatedLines.push(`${k}=${String(v)}`);
    }
  }

  const finalContent = updatedLines.join('\n').replace(/\n*$/, '\n');
  fs.writeFileSync(envFilePath, finalContent, 'utf8');
}

/**
 * End-to-end auto deploy from local folder.
 * @param {object} opts
 * @param {string} opts.folderPath
 * @param {object} opts.projectManager
 * @param {object} opts.deploymentManager
 * @param {object} [opts.serviceManager]
 * @param {string} [opts.actor]
 * @param {string} [opts.customName]
 * @param {number} [opts.customPort]
 * @param {object} [opts.customEnv]
 * @param {string} [opts.customRepoUrl]
 * @param {string} [opts.customBranch]
 * @returns {Promise<object>}
 */
export async function deployFolderProject({
  folderPath,
  projectManager,
  deploymentManager,
  serviceManager = null,
  actor = 'desktop-dropzone',
  customName = null,
  customPort = null,
  customEnv = null,
  customRepoUrl = null,
  customBranch = null,
}) {
  if (!projectManager || !deploymentManager) {
    throw new Error('projectManager dan deploymentManager wajib disediakan.');
  }

  // 1. Deep inspect folder
  const inspection = deepInspectProjectFolder(folderPath);

  // 2. Query used ports
  let usedPorts = [];
  if (serviceManager && typeof serviceManager.listServices === 'function') {
    try {
      const svcs = serviceManager.listServices();
      usedPorts = svcs.map((s) => s.port).filter(Boolean);
    } catch {
      /* ignore */
    }
  }

  // 3. Allocate or validate custom port
  let port;
  if (customPort && Number.isInteger(Number(customPort)) && Number(customPort) > 0) {
    port = Number(customPort);
  } else {
    port = await allocateSafePort({ usedPorts });
  }

  // 4. Ensure project name is unique
  let name = sanitizeProjectName(customName || inspection.suggestedName);
  let counter = 1;
  const baseName = name;
  while (true) {
    const existing = projectManager.store?.db
      ?.prepare('SELECT id FROM projects WHERE name = ?')
      ?.get(name);
    if (!existing) break;
    name = `${baseName}-${counter++}`;
  }

  // 5. Create project
  const isHermes = Boolean(inspection.details?.isHermesAgent || isHermesAgentProject(folderPath));
  const isBot = Boolean(
    inspection.framework?.includes('Bot') ||
    inspection.framework?.includes('Telegram') ||
    inspection.framework?.includes('Discord') ||
    isHermes
  );
  const healthCheck = isBot ? { type: 'process' } : undefined;
  const startCmd = isHermes ? 'main.py' : (inspection.entryFile || undefined);
  const repoUrl = customRepoUrl || inspection.gitInfo?.repoUrl || undefined;
  const branch = customBranch || inspection.gitInfo?.branch || undefined;
  const project = projectManager.createProject({
    name,
    type: inspection.type,
    port,
    startCmd,
    healthCheck,
    repoUrl,
    branch,
  });

  // 6. Copy files to workspace
  copyWorkspaceFiles(folderPath, project.workspacePath);

  // 6a. Ensure Node.js projects have a valid package.json in workspace with runnable start script
  if (inspection.type === 'node') {
    const wsPkg = path.join(project.workspacePath, 'package.json');
    if (!fs.existsSync(wsPkg)) {
      const entry = inspection.entryFile || 'index.js';
      const minimalPkg = {
        name: project.name,
        version: '1.0.0',
        main: entry,
        scripts: {
          start: `node ${entry}`,
        },
      };
      fs.writeFileSync(wsPkg, JSON.stringify(minimalPkg, null, 2), 'utf8');
    } else {
      try {
        const pkg = JSON.parse(fs.readFileSync(wsPkg, 'utf8'));
        if (!pkg.scripts || !pkg.scripts.start) {
          const entry = inspection.entryFile || pkg.main || 'index.js';
          pkg.scripts = { ...(pkg.scripts || {}), start: `node ${entry}` };
          fs.writeFileSync(wsPkg, JSON.stringify(pkg, null, 2), 'utf8');
        }
      } catch {}
    }
  }

  // 6a2. Ensure Python projects have an entrypoint at root or wrapper
  if (inspection.type === 'python') {
    const wsMain = path.join(project.workspacePath, 'main.py');
    if (isHermes) {
      const hermesGatewayWrapper = `# Auto-generated Hermes Agent gateway runner by VM-Panel
import sys
import os

root_dir = os.path.dirname(os.path.abspath(__file__))
os.environ["HERMES_HOME"] = root_dir
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

from hermes_cli.main import main

if __name__ == '__main__':
    sys.argv = ['hermes', 'gateway', 'run']
    sys.exit(main())
`;
      try {
        fs.writeFileSync(wsMain, hermesGatewayWrapper, 'utf8');
      } catch {}
    } else if (!fs.existsSync(wsMain) && inspection.entryFile && inspection.entryFile !== 'main.py') {
      const entryRel = inspection.entryFile.replace(/\\/g, '/');
      const wrapper = `# Auto-generated root entrypoint forwarder by VM-Panel\nimport os, sys, runpy\n\nroot_dir = os.path.dirname(os.path.abspath(__file__))\nentry_path = os.path.join(root_dir, ${JSON.stringify(entryRel)})\nentry_dir = os.path.dirname(entry_path)\nif entry_dir not in sys.path:\n    sys.path.insert(0, entry_dir)\nif root_dir not in sys.path:\n    sys.path.insert(1, root_dir)\n\nif os.path.exists(entry_path):\n    runpy.run_path(entry_path, run_name="__main__")\nelse:\n    raise FileNotFoundError(f"Entrypoint file '{entry_path}' tidak ditemukan")\n`;
      try {
        fs.writeFileSync(wsMain, wrapper, 'utf8');
      } catch {}
    }
  }

  // 6b. Inject customEnv into workspace .env if provided (upsert in-place)
  if (customEnv && typeof customEnv === 'object' && Object.keys(customEnv).length > 0) {
    const envPath = path.join(project.workspacePath, '.env');
    upsertEnvFile(envPath, customEnv);
  }

  // 7. Deploy project
  const deployResult = await deploymentManager.deploy({
    projectId: project.id,
    source: { type: 'workspace' },
    actor,
  });

  return {
    success: true,
    project: {
      id: project.id,
      name: project.name,
      type: project.type,
      port: project.port,
      workspacePath: project.workspacePath,
    },
    inspection,
    deployment: deployResult,
  };
}
