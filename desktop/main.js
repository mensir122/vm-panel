// desktop/main.js — Native Windows Desktop Application for VM-Panel.
// ESM module, Node >= 20.

import { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, globalShortcut } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { inspectProjectFolder, allocateSafePort, copyWorkspaceFiles, upsertEnvFile, isHermesAgentProject } from './deployer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveNodeBinary() {
  if (process.env.NODE_BINARY && fs.existsSync(process.env.NODE_BINARY)) {
    return process.env.NODE_BINARY;
  }
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'node', 'node.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'node.exe'),
  ];
  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) return cand;
  }
  return 'node';
}

function resolveProjectRoot() {
  const candidates = [
    process.env.VM_PANEL_ROOT,
    process.cwd(),
    path.resolve(path.dirname(process.execPath), '..', '..'),
    path.resolve(__dirname, '..'),
  ];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app'));
  }

  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (dir.includes('.asar')) continue;
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) {
        const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
        const hasManager = fs.existsSync(path.join(dir, 'manager', 'index.js'));
        if (hasPkg && hasManager) {
          return path.resolve(dir);
        }
      }
    } catch {
      /* ignore invalid path */
    }
  }

  const fallback = path.resolve(__dirname, '..');
  return fallback.includes('.asar') ? path.resolve(path.dirname(process.execPath), '..', '..') : fallback;
}

const ROOT = resolveProjectRoot();

try {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch {}

const NODE_BIN = resolveNodeBinary();

const MANAGER_PORT = Number(process.env.MANAGER_API_PORT || 8097);
const PANEL_PORT = Number(process.env.PANEL_PORT || 8080);
const TOKEN_FILE = path.join(ROOT, 'runtime', 'sockets', 'cli-token');
const DATA_DIR = path.join(ROOT, 'data');

let mainWindow = null;
let tray = null;
let isQuitting = false;
const backgroundKids = [];

function logDesktop(msg) {
  const line = `[desktop ${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    const logDir = path.join(ROOT, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'desktop.log'), line);
  } catch {
    /* best-effort logging */
  }
}

function spawnBackgroundProcess(name, relativeScript, envOverrides = {}) {
  const scriptPath = path.join(ROOT, relativeScript);
  logDesktop(`Spawning background process [${name}]: "${NODE_BIN}" "${scriptPath}" (cwd: ${ROOT})`);
  const child = spawn(NODE_BIN, [scriptPath], {
    cwd: ROOT,
    env: { ...process.env, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.on('error', (err) => {
    logDesktop(`[${name}:spawn_err] Failed to spawn child process: ${err.message || err}`);
  });

  child.stdout.on('data', (d) => {
    const s = String(d).trim();
    if (s) logDesktop(`[${name}] ${s}`);
  });

  child.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) logDesktop(`[${name}:err] ${s}`);
  });

  child.on('exit', (code, signal) => {
    logDesktop(`[${name}] Exited with code=${code} signal=${signal ?? ''}`);
  });

  backgroundKids.push({ name, child });
  return child;
}

async function waitForHealth(checkFn, timeoutMs = 60000, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await checkFn();
      if (ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function checkManagerHealth() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return false;
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!token) return false;
    const res = await fetch(`http://127.0.0.1:${MANAGER_PORT}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function checkPanelHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/login`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.status === 200 || res.status === 302;
  } catch {
    return false;
  }
}

async function startInternalServices() {
  const managerAlreadyRunning = await checkManagerHealth();
  if (managerAlreadyRunning) {
    logDesktop('Manager API is already active & healthy on port ' + MANAGER_PORT);
  } else {
    logDesktop('Starting Manager API on port ' + MANAGER_PORT);
    spawnBackgroundProcess('manager', 'manager/index.js', {
      PORT: String(MANAGER_PORT),
    });

    const managerOk = await waitForHealth(checkManagerHealth, 90000);
    if (!managerOk) {
      throw new Error('Manager API failed to report healthy status within 90s');
    }
    logDesktop('Manager API is healthy (port ' + MANAGER_PORT + ')');
  }

  const panelAlreadyRunning = await checkPanelHealth();
  if (panelAlreadyRunning) {
    logDesktop('Panel UI is already active & healthy on port ' + PANEL_PORT);
  } else {
    logDesktop('Starting Panel Web Server on port ' + PANEL_PORT);
    spawnBackgroundProcess('panel', 'panel/server/index.js', {
      PORT: String(PANEL_PORT),
      MANAGER_API_PORT: String(MANAGER_PORT),
    });

    const panelOk = await waitForHealth(checkPanelHealth, 60000);
    if (!panelOk) {
      throw new Error('Panel UI failed to report healthy status within 60s');
    }
    logDesktop('Panel UI is healthy (port ' + PANEL_PORT + ')');
  }

  // Check 9Router VM (port 20127) if configured
  const vmRouterApp = path.join(process.env.APPDATA || '', 'vm-router', 'app', 'server.js');
  const vmRouterScript = path.join(ROOT, 'scripts', 'start-vm-router.mjs');
  if (fs.existsSync(vmRouterApp) && fs.existsSync(vmRouterScript)) {
    try {
      const routerRes = await fetch('http://127.0.0.1:20127/health', { signal: AbortSignal.timeout(1000) });
      if (routerRes.ok) {
        logDesktop('9Router VM is already active on port 20127.');
      } else {
        throw new Error('not ok');
      }
    } catch {
      logDesktop('Detected 9Router VM isolated app — starting on port 20127...');
      spawnBackgroundProcess('9router-vm', 'scripts/start-vm-router.mjs', {
        ROUTER_PORT: '20127',
        ROUTER_HOST: '127.0.0.1',
      });
    }
  }
}

function createMainWindow() {
  const iconPath = fs.existsSync(path.join(__dirname, 'assets', 'icon.png'))
    ? path.join(__dirname, 'assets', 'icon.png')
    : path.join(__dirname, 'assets', 'icon.svg');
  const appIcon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#080b11',
    icon: appIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Keyboard shortcuts: F5/Ctrl+R for reload, F12/Ctrl+Shift+I for DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
        logDesktop('Reloading window content (cache bypass)...');
        mainWindow.webContents.reloadIgnoringCache();
      } else if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
        mainWindow.webContents.toggleDevTools();
      }
    }
  });

  // Intercept window close to minimize to Windows System Tray
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      logDesktop('Window minimized to System Tray. Services continue running 24/7.');
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    logDesktop('Main window displayed.');
  });

  mainWindow.webContents.session.clearCache().then(() => {
    mainWindow.loadURL(`http://127.0.0.1:${PANEL_PORT}`);
  }).catch(() => {
    mainWindow.loadURL(`http://127.0.0.1:${PANEL_PORT}`);
  });
}

function createSystemTray() {
  const iconPath = fs.existsSync(path.join(__dirname, 'assets', 'icon.png'))
    ? path.join(__dirname, 'assets', 'icon.png')
    : path.join(__dirname, 'assets', 'icon.svg');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('VM-Panel Desktop — 24/7 Operations Engine');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'VM-Panel Desktop · 24/7 Active', enabled: false },
    { type: 'separator' },
    {
      label: 'Buka Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Muat Ulang Tampilan (Reload)',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.reloadIgnoringCache();
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Status Service',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.loadURL(`http://127.0.0.1:${PANEL_PORT}/services`);
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Buka Folder Data',
      click: () => {
        shell.openPath(DATA_DIR);
      },
    },
    { type: 'separator' },
    {
      label: 'Auto-Launch saat Windows Startup',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        logDesktop(`Auto-launch at login toggled: ${item.checked}`);
      },
    },
    { type: 'separator' },
    {
      label: 'Keluar Total',
      click: () => {
        logDesktop('User selected Keluar Total from System Tray.');
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function setupIpcHandlers() {
  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close(); // Triggers tray minimize via window 'close' listener
  });

  ipcMain.handle('window-is-maximized', () => {
    return mainWindow ? mainWindow.isMaximized() : false;
  });

  ipcMain.on('open-data-folder', () => {
    shell.openPath(DATA_DIR);
  });

  ipcMain.handle('select-folder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Pilih Folder Project untuk Dideploy ke VM-Panel',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('deploy-folder', async (_event, folderPath, options = {}) => {
    try {
      logDesktop(`IPC deploy-folder requested for: ${folderPath}`);
      if (!fs.existsSync(TOKEN_FILE)) {
        throw new Error('Manager token file belum siap.');
      }
      const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

      const inspection = inspectProjectFolder(folderPath);

      // Query existing services
      let usedPorts = [];
      try {
        const res = await fetch(`http://127.0.0.1:${MANAGER_PORT}/services`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const svcs = await res.json();
          if (Array.isArray(svcs)) {
            usedPorts = svcs.map((s) => s.port).filter(Boolean);
          }
        }
      } catch {
        /* best-effort */
      }

      const port = await allocateSafePort({ usedPorts });
      const isBot =
        (inspection.framework && /bot|telegram|discord|slack|whatsapp|agent|worker|crawler|scraper|runner|queue|consumer|daemon|cli/i.test(inspection.framework)) ||
        /bot|telegram|discord|slack|whatsapp|agent|worker|crawler|scraper|runner|queue|consumer|daemon|cli/i.test(inspection.suggestedName);

      // Create or reuse project
      let project;
      const createRes = await fetch(`http://127.0.0.1:${MANAGER_PORT}/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: inspection.suggestedName,
          type: inspection.type,
          port,
          startCmd: inspection.entryFile || undefined,
          healthCheck: isBot ? { type: 'process' } : undefined,
        }),
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        if (errText.includes('sudah dipakai')) {
          const pListRes = await fetch(`http://127.0.0.1:${MANAGER_PORT}/projects`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const pList = pListRes.ok ? await pListRes.json() : [];
          const found = Array.isArray(pList) ? pList.find((p) => p.name === inspection.suggestedName) : null;
          if (found) {
            try {
              await fetch(`http://127.0.0.1:${MANAGER_PORT}/projects/${encodeURIComponent(found.id)}`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                  startCmd: inspection.entryFile || undefined,
                  port,
                  healthCheck: isBot ? { type: 'process' } : undefined,
                }),
              });
            } catch {}
            const detailRes = await fetch(`http://127.0.0.1:${MANAGER_PORT}/projects/${encodeURIComponent(found.id)}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            project = detailRes.ok ? await detailRes.json() : found;
          } else {
            throw new Error(`Gagal membuat project di manager: ${errText}`);
          }
        } else {
          throw new Error(`Gagal membuat project di manager: ${errText}`);
        }
      } else {
        project = await createRes.json();
      }
      logDesktop(`Project target ready: ${project.id} (${project.name}) on port ${project.port}`);

      // Copy folder to project workspace
      if (project.workspacePath) {
        copyWorkspaceFiles(folderPath, project.workspacePath);
        logDesktop(`Workspace files copied to: ${project.workspacePath}`);

        // If Node.js project, ensure root package.json exists in workspace with start script
        if (inspection.type === 'node') {
          const wsPkg = path.join(project.workspacePath, 'package.json');
          if (!fs.existsSync(wsPkg)) {
            const entry = inspection.entryFile || 'index.js';
            const subPkgPath = path.join(project.workspacePath, path.dirname(entry), 'package.json');
            let subPkg = {};
            try {
              if (fs.existsSync(subPkgPath)) subPkg = JSON.parse(fs.readFileSync(subPkgPath, 'utf8'));
            } catch {}
            const minimalPkg = {
              name: inspection.suggestedName,
              version: subPkg.version || '1.0.0',
              main: entry,
              scripts: {
                start: subPkg.scripts?.start ? `npm --prefix ${path.dirname(entry).replaceAll('\\', '/')} start` : `node ${entry}`,
                ...(subPkg.scripts || {}),
              },
              dependencies: subPkg.dependencies || {},
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

        // If Python project, ensure root entrypoint exists or wrapper forwards to entryFile
        if (inspection.type === 'python') {
          const wsMain = path.join(project.workspacePath, 'main.py');
          const isHermes = Boolean(inspection.details?.isHermesAgent || isHermesAgentProject(folderPath));
          if (isHermes) {
            const hermesGatewayWrapper = `# Auto-generated Hermes Agent gateway runner by VM-Panel\nimport sys\nimport os\n\nroot_dir = os.path.dirname(os.path.abspath(__file__))\nos.environ["HERMES_HOME"] = root_dir\nif root_dir not in sys.path:\n    sys.path.insert(0, root_dir)\n\nfrom hermes_cli.main import main\n\nif __name__ == '__main__':\n    sys.argv = ['hermes', 'gateway', 'run']\n    sys.exit(main())\n`;
            try {
              fs.writeFileSync(wsMain, hermesGatewayWrapper, 'utf8');
              logDesktop('Generated persistent Hermes Agent gateway runner main.py');
            } catch (err) {
              logDesktop(`Could not write Hermes main.py: ${err.message}`);
            }
          } else if (!fs.existsSync(wsMain) && inspection.entryFile && inspection.entryFile !== 'main.py') {
            const entryRel = inspection.entryFile.replace(/\\/g, '/');
            const wrapper = `# Auto-generated root entrypoint forwarder by VM-Panel\nimport os, sys, runpy\n\nroot_dir = os.path.dirname(os.path.abspath(__file__))\nentry_path = os.path.join(root_dir, ${JSON.stringify(entryRel)})\nentry_dir = os.path.dirname(entry_path)\nif entry_dir not in sys.path:\n    sys.path.insert(0, entry_dir)\nif root_dir not in sys.path:\n    sys.path.insert(1, root_dir)\n\nif os.path.exists(entry_path):\n    runpy.run_path(entry_path, run_name="__main__")\nelse:\n    raise FileNotFoundError(f"Entrypoint file '{entry_path}' tidak ditemukan")\n`;
            try {
              fs.writeFileSync(wsMain, wrapper, 'utf8');
              logDesktop(`Created root main.py forwarder for ${entryRel}`);
            } catch (err) {
              logDesktop(`Could not write root main.py wrapper: ${err.message}`);
            }
          }
        }

        // Inject custom environment variables if provided
        const customEnv = options?.env || null;
        if (customEnv && typeof customEnv === 'object') {
          const envPath = path.join(project.workspacePath, '.env');
          upsertEnvFile(envPath, customEnv);
        }
      }

      // Deploy project
      const deployRes = await fetch(
        `http://127.0.0.1:${MANAGER_PORT}/projects/${encodeURIComponent(project.id)}/deploy`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ source: { type: 'workspace' } }),
        }
      );

      if (!deployRes.ok) {
        const errText = await deployRes.text();
        throw new Error(`Pipeline deployment gagal: ${errText}`);
      }

      const deployment = await deployRes.json();
      logDesktop(`Project ${project.name} deployed successfully (deployment: ${deployment.deploymentId || 'ok'})`);

      return {
        ok: true,
        project,
        deployment,
        message: `Project ${project.name} berhasil di-deploy di port ${project.port}!`,
      };
    } catch (err) {
      logDesktop(`IPC deploy-folder error: ${err.message || err}`);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

async function shutdownAllProcesses() {
  logDesktop('Performing graceful shutdown of background services...');
  for (const { name, child } of backgroundKids) {
    try {
      logDesktop(`Terminating [${name}] (PID: ${child.pid})...`);
      child.kill('SIGTERM');
    } catch {
      /* already exited */
    }
  }

  // Wait 1200ms for WAL checkpoints to flush
  await new Promise((r) => setTimeout(r, 1200));

  for (const { name, child } of backgroundKids) {
    try {
      if (child.exitCode === null && !child.killed) {
        logDesktop(`Force killing [${name}]...`);
        child.kill('SIGKILL');
      }
    } catch {
      /* ignore */
    }
  }
}

// Electron Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logDesktop('Another instance of VM-Panel Desktop is already running. Exiting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.webContents.reloadIgnoringCache();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    logDesktop('Electron app ready. Starting background engines...');
    setupIpcHandlers();

    // Global Shortcuts
    try {
      // Toggle Window: Ctrl+Alt+V
      globalShortcut.register('CommandOrControl+Alt+V', () => {
        if (mainWindow) {
          if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      });

      // Quick Navigate to Dashboard: Ctrl+Shift+D
      globalShortcut.register('CommandOrControl+Shift+D', () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.loadURL(`http://127.0.0.1:${PANEL_PORT}/dashboard`);
          mainWindow.focus();
        }
      });

      // Quick Navigate to Services: Ctrl+Shift+S
      globalShortcut.register('CommandOrControl+Shift+S', () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.loadURL(`http://127.0.0.1:${PANEL_PORT}/services`);
          mainWindow.focus();
        }
      });

      logDesktop('Global keyboard shortcuts registered (Ctrl+Alt+V, Ctrl+Shift+D, Ctrl+Shift+S).');
    } catch (e) {
      logDesktop(`Warning: Could not register some global shortcuts: ${e.message}`);
    }

    try {
      await startInternalServices();
      createMainWindow();
      createSystemTray();
    } catch (err) {
      logDesktop(`Startup fatal error: ${err.message || err}`);
      dialog.showErrorBox(
        'VM-Panel Desktop — Error Memulai Layanan',
        `Gagal memulai server latar belakang:\n${err.message || err}\n\nPeriksa log di logs/desktop.log.`
      );
      app.quit();
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('before-quit', async (event) => {
    if (!isQuitting) {
      isQuitting = true;
      event.preventDefault();
      await shutdownAllProcesses();
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    // On Windows, keep app running in tray unless user explicitly selected Keluar Total
    if (process.platform !== 'win32' || isQuitting) {
      app.quit();
    }
  });
}
