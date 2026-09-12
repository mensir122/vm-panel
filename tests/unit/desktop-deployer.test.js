// tests/unit/desktop-deployer.test.js — Unit test untuk modul deployer Drag & Drop desktop.
// Mengikuti aturan AGENTS.md: node:test bawaan, sandbox terisolasi.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  sanitizeProjectName,
  portBindTest,
  allocateSafePort,
  inspectProjectFolder,
  deepInspectProjectFolder,
  copyWorkspaceFiles,
  isHermesAgentProject,
  upsertEnvFile,
  detectFolderGitInfo,
  detectPackageRepoUrl,
  cleanRepoUrl,
  isSensitiveFile,
  RESERVED_PORTS,
} from '../../desktop/deployer.js';

describe('desktop/deployer.js — Inspeksi folder & alokasi port', () => {
  let tmpRoot;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpanel-deployer-test-'));
  });

  after(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup on windows */
      }
    }
  });

  test('sanitizeProjectName: membersihkan nama dan format kanonik', () => {
    assert.equal(sanitizeProjectName('My Awesome App!'), 'my-awesome-app');
    assert.equal(sanitizeProjectName('__cool_bot__123'), 'cool-bot-123');
    assert.equal(sanitizeProjectName('a'), 'a-app');
    assert.ok(sanitizeProjectName('').length >= 2);
    assert.ok(sanitizeProjectName('a'.repeat(100)).length <= 63);
  });

  test('portBindTest & allocateSafePort: alokasi port legal tanpa tabrakan', async () => {
    const port = await allocateSafePort({ startPort: 25000 });
    assert.ok(port >= 25000 && port <= 65535);
    assert.ok(!RESERVED_PORTS.includes(port));

    const canBind = await portBindTest(port);
    assert.equal(canBind, true, 'Port yang dialokasikan harus bisa di-bind');
  });

  test('inspectProjectFolder: deteksi Node.js project via package.json', () => {
    const nodeDir = path.join(tmpRoot, 'my-node-app');
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(nodeDir, 'package.json'),
      JSON.stringify({ name: 'custom-node-pkg', main: 'app.js' })
    );

    const info = inspectProjectFolder(nodeDir);
    assert.equal(info.type, 'node');
    assert.equal(info.suggestedName, 'custom-node-pkg');
    assert.equal(info.entryFile, 'app.js');
  });

  test('inspectProjectFolder: deteksi Python project via requirements.txt atau main.py', () => {
    const pyDir = path.join(tmpRoot, 'telegram-bot-py');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'main.py'), '# python main file\nprint("hello")');
    fs.writeFileSync(path.join(pyDir, 'requirements.txt'), 'requests==2.31.0\n');

    const info = inspectProjectFolder(pyDir);
    assert.equal(info.type, 'python');
    assert.equal(info.suggestedName, 'telegram-bot-py');
    assert.equal(info.entryFile, 'main.py');
    assert.equal(info.details.hasRequirements, true);
  });

  test('inspectProjectFolder: deteksi Static Web via index.html', () => {
    const staticDir = path.join(tmpRoot, 'landing-page');
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><h1>Landing</h1>');

    const info = inspectProjectFolder(staticDir);
    assert.equal(info.type, 'static');
    assert.equal(info.suggestedName, 'landing-page');
    assert.equal(info.entryFile, 'index.html');
  });

  test('inspectProjectFolder: error jika tipe tidak dikenali atau path invalid', () => {
    const emptyDir = path.join(tmpRoot, 'empty-folder');
    fs.mkdirSync(emptyDir, { recursive: true });

    assert.throws(
      () => inspectProjectFolder(emptyDir),
      /Tipe project tidak dikenali/
    );

    assert.throws(
      () => inspectProjectFolder(path.join(tmpRoot, 'non-existent-dir')),
      /Direktori tidak ditemukan/
    );
  });

  test('copyWorkspaceFiles: menyalin file dan mengabaikan node_modules, .git, dan .venv', () => {
    const srcDir = path.join(tmpRoot, 'source-project');
    const destDir = path.join(tmpRoot, 'dest-workspace');
    fs.mkdirSync(path.join(srcDir, 'node_modules', 'foo'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, '.venv'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'src'), { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'node_modules', 'foo', 'index.js'), 'junk');
    fs.writeFileSync(path.join(srcDir, '.git', 'config'), 'junk');
    fs.writeFileSync(path.join(srcDir, '.venv', 'pyvenv.cfg'), 'junk');
    fs.writeFileSync(path.join(srcDir, 'package.json'), '{"name":"clean"}');
    fs.writeFileSync(path.join(srcDir, 'src', 'index.js'), 'console.log("clean");');

    copyWorkspaceFiles(srcDir, destDir);

    assert.ok(fs.existsSync(path.join(destDir, 'package.json')));
    assert.ok(fs.existsSync(path.join(destDir, 'src', 'index.js')));
    assert.ok(!fs.existsSync(path.join(destDir, 'node_modules')));
    assert.ok(!fs.existsSync(path.join(destDir, '.git')));
    assert.ok(!fs.existsSync(path.join(destDir, '.venv')));
  });

  test('deepInspectProjectFolder: deteksi framework Telegraf & env BOT_TOKEN pada Node.js', () => {
    const botDir = path.join(tmpRoot, 'telegram-node-bot');
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(
      path.join(botDir, 'package.json'),
      JSON.stringify({
        name: 'my-telegram-bot',
        dependencies: { telegraf: '^4.12.0' },
        scripts: { start: 'node index.js' },
      })
    );
    fs.writeFileSync(
      path.join(botDir, 'index.js'),
      'const token = process.env.BOT_TOKEN;\nconst port = process.env.PORT || 3000;\nconsole.log(token, port);'
    );

    const insp = deepInspectProjectFolder(botDir);
    assert.equal(insp.type, 'node');
    assert.equal(insp.framework, 'Telegraf (Telegram Bot)');
    assert.ok(insp.detectedEnvs.some((e) => e.key === 'BOT_TOKEN' && e.type === 'secret'));
    assert.ok(insp.detectedEnvs.some((e) => e.key === 'PORT' && e.type === 'port'));
    assert.ok(insp.totalFiles >= 2);
  });

  test('deepInspectProjectFolder: deteksi FastAPI & requirements.txt pada Python', () => {
    const pyDir = path.join(tmpRoot, 'fastapi-backend');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'requirements.txt'), 'fastapi==0.110.0\nuvicorn==0.28.0\n');
    fs.writeFileSync(
      path.join(pyDir, 'main.py'),
      'import os\ndb = os.getenv("DATABASE_URL")\nprint(db)'
    );

    const insp = deepInspectProjectFolder(pyDir);
    assert.equal(insp.type, 'python');
    assert.equal(insp.framework, 'FastAPI (Python Web API)');
    assert.ok(insp.detectedEnvs.some((e) => e.key === 'DATABASE_URL' && e.type === 'database'));
  });

  test('deepInspectProjectFolder: deteksi Python Telegram bot via bot.py tanpa requirements.txt', () => {
    const botDir = path.join(tmpRoot, 'hermes-bot-python');
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(
      path.join(botDir, 'bot.py'),
      'import os\nfrom aiogram import Bot, Dispatcher\ntoken = os.getenv("BOT_TOKEN")\nbot = Bot(token=token)'
    );

    const insp = deepInspectProjectFolder(botDir);
    assert.equal(insp.type, 'python');
    assert.equal(insp.entryFile, 'bot.py');
    assert.equal(insp.framework, 'Aiogram (Telegram Bot)');
    assert.ok(insp.detectedEnvs.some((e) => e.key === 'BOT_TOKEN'));
  });

  test('inspectProjectFolder: deteksi Node script tunggal tanpa package.json', () => {
    const singleJsDir = path.join(tmpRoot, 'single-script-app');
    fs.mkdirSync(singleJsDir, { recursive: true });
    fs.writeFileSync(path.join(singleJsDir, 'bot.js'), 'console.log("running standalone");');

    const insp = inspectProjectFolder(singleJsDir);
    assert.equal(insp.type, 'node');
    assert.equal(insp.entryFile, 'bot.js');
  });

  test('isHermesAgentProject & inspect: deteksi Hermes AI Agent dan arahkan entry ke main.py', () => {
    const hermesDir = path.join(tmpRoot, 'hermes-sample');
    fs.mkdirSync(path.join(hermesDir, 'hermes_cli'), { recursive: true });
    fs.writeFileSync(path.join(hermesDir, 'hermes.bat'), '@echo off\npython -m hermes_cli.main %*');
    fs.writeFileSync(path.join(hermesDir, 'config.yaml'), 'model:\n  default: Hermes-VM\n');

    assert.equal(isHermesAgentProject(hermesDir), true);
    const insp = inspectProjectFolder(hermesDir);
    assert.equal(insp.type, 'python');
    assert.equal(insp.entryFile, 'main.py');
    assert.equal(insp.details.isHermesAgent, true);

    const deep = deepInspectProjectFolder(hermesDir);
    assert.equal(deep.framework, 'Hermes AI Agent (Telegram / Multi-Platform)');
  });

  test('upsertEnvFile: mengganti nilai in-place tanpa baris duplikat dan mempertahankan komentar', () => {
    const envDir = path.join(tmpRoot, 'env-test');
    fs.mkdirSync(envDir, { recursive: true });
    const envFile = path.join(envDir, '.env');

    fs.writeFileSync(envFile, '# Bot Settings\nBOT_TOKEN=token_lama_123\nPORT=3000\n# Other\nLOG_LEVEL=debug\n', 'utf8');

    upsertEnvFile(envFile, {
      BOT_TOKEN: 'token_baru_456',
      NEW_VAR: 'hello_world',
    });

    const content = fs.readFileSync(envFile, 'utf8');
    assert.ok(content.includes('BOT_TOKEN=token_baru_456'), 'token harus diperbarui');
    assert.ok(!content.includes('token_lama_123'), 'token lama tidak boleh ada');
    assert.ok(content.includes('# Bot Settings'), 'komentar harus dipertahankan');
    assert.ok(content.includes('PORT=3000'), 'variabel lain harus tetap utuh');
    assert.ok(content.includes('NEW_VAR=hello_world'), 'variabel baru harus ditambahkan');

    // Pastikan BOT_TOKEN hanya muncul 1 kali
    const matches = content.match(/^BOT_TOKEN=.*$/gm);
    assert.equal(matches.length, 1, 'tidak boleh ada duplikasi key');
  });

  test('detectFolderGitInfo: mengekstrak remote origin url dan branch dari .git/config & HEAD', () => {
    const gitDir = path.join(tmpRoot, 'git-sample');
    fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, '.git', 'HEAD'), 'ref: refs/heads/feature-bot\n', 'utf8');
    fs.writeFileSync(
      path.join(gitDir, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/myuser/sample-bot.git\n',
      'utf8'
    );

    const info = detectFolderGitInfo(gitDir);
    assert.ok(info);
    assert.equal(info.repoUrl, 'https://github.com/myuser/sample-bot');
    assert.equal(info.branch, 'feature-bot');
  });

  test('detectPackageRepoUrl: membaca repository URL dari package.json (string & object)', () => {
    const pkgDir1 = path.join(tmpRoot, 'pkg-repo-1');
    fs.mkdirSync(pkgDir1, { recursive: true });
    fs.writeFileSync(path.join(pkgDir1, 'package.json'), JSON.stringify({ name: 'p1', repository: 'github:cool/repo' }), 'utf8');
    assert.equal(detectPackageRepoUrl(pkgDir1), 'https://github.com/cool/repo');

    const pkgDir2 = path.join(tmpRoot, 'pkg-repo-2');
    fs.mkdirSync(pkgDir2, { recursive: true });
    fs.writeFileSync(path.join(pkgDir2, 'package.json'), JSON.stringify({ name: 'p2', repository: { url: 'git+https://github.com/cool/repo2.git' } }), 'utf8');
    assert.equal(detectPackageRepoUrl(pkgDir2), 'https://github.com/cool/repo2');
  });

  test('deepInspectProjectFolder: menyertakan gitInfo dengan remote URL terdeteksi', () => {
    const projectDir = path.join(tmpRoot, 'deep-git-project');
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    fs.writeFileSync(
      path.join(projectDir, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/company/auto-bot.git\n',
      'utf8'
    );
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'auto-bot', main: 'index.js' }), 'utf8');

    const inspection = deepInspectProjectFolder(projectDir);
    assert.ok(inspection.gitInfo);
    assert.equal(inspection.gitInfo.repoUrl, 'https://github.com/company/auto-bot');
    assert.equal(inspection.gitInfo.branch, 'main');
  });

  test('cleanRepoUrl: membersihkan token, kredensial, SCP SSH, dan .git suffix', () => {
    assert.equal(cleanRepoUrl('https://ghp_secretToken123@github.com/myuser/my-repo.git'), 'https://github.com/myuser/my-repo');
    assert.equal(cleanRepoUrl('https://user:password123@gitlab.com/org/project.git'), 'https://gitlab.com/org/project');
    assert.equal(cleanRepoUrl('git@github.com:myorg/super-bot.git'), 'https://github.com/myorg/super-bot');
    assert.equal(cleanRepoUrl('git+https://github.com/foo/bar.git'), 'https://github.com/foo/bar');
    assert.equal(cleanRepoUrl('https://github.com/owner/repo/'), 'https://github.com/owner/repo');
    assert.equal(cleanRepoUrl(null), null);
    assert.equal(cleanRepoUrl('   '), null);
    assert.equal(cleanRepoUrl(123), null);
  });

  test('isSensitiveFile: mendeteksi file secret/kredensial dan membiarkan .example aman', () => {
    assert.equal(isSensitiveFile('.env'), true);
    assert.equal(isSensitiveFile('.env.local'), true);
    assert.equal(isSensitiveFile('.env.production'), true);
    assert.equal(isSensitiveFile('private.key'), true);
    assert.equal(isSensitiveFile('server.pem'), true);
    assert.equal(isSensitiveFile('id_rsa'), true);
    assert.equal(isSensitiveFile('id_ed25519'), true);
    assert.equal(isSensitiveFile('credentials.json'), true);
    assert.equal(isSensitiveFile('service-account.json'), true);
    assert.equal(isSensitiveFile('client_secret.json'), true);

    // File yang aman
    assert.equal(isSensitiveFile('.env.example'), false);
    assert.equal(isSensitiveFile('package.json'), false);
    assert.equal(isSensitiveFile('index.js'), false);
    assert.equal(isSensitiveFile('README.md'), false);
  });

  test('copyWorkspaceFiles: ignoreEnv=true mencegah bocornya file rahasia ke public sources', () => {
    const srcDir = path.join(tmpRoot, 'secure-src');
    const destDir = path.join(tmpRoot, 'secure-dest');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'index.js'), 'console.log("hello");');
    fs.writeFileSync(path.join(srcDir, '.env'), 'BOT_TOKEN=supersecret123');
    fs.writeFileSync(path.join(srcDir, '.env.local'), 'DB_PASS=secretpass');
    fs.writeFileSync(path.join(srcDir, '.env.example'), 'BOT_TOKEN=your_token_here');
    fs.writeFileSync(path.join(srcDir, 'credentials.json'), '{"key":"secret"}');
    fs.writeFileSync(path.join(srcDir, 'service-account.json'), '{"private_key":"..."}');

    copyWorkspaceFiles(srcDir, destDir, { ignoreEnv: true });

    assert.ok(fs.existsSync(path.join(destDir, 'index.js')), 'kode sumber harus disalin');
    assert.ok(fs.existsSync(path.join(destDir, '.env.example')), '.env.example harus disalin sebagai panduan');
    assert.ok(!fs.existsSync(path.join(destDir, '.env')), '.env TIDAK BOLEH disalin');
    assert.ok(!fs.existsSync(path.join(destDir, '.env.local')), '.env.local TIDAK BOLEH disalin');
    assert.ok(!fs.existsSync(path.join(destDir, 'credentials.json')), 'credentials.json TIDAK BOLEH disalin');
    assert.ok(!fs.existsSync(path.join(destDir, 'service-account.json')), 'service-account.json TIDAK BOLEH disalin');
  });

  test('copyWorkspaceFiles: entri symlink selalu dilewati, tidak pernah diikuti (A2#23)', (t) => {
    const srcDir = path.join(tmpRoot, 'sym-src');
    const destDir = path.join(tmpRoot, 'sym-dest');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'app.js'), 'ok');
    fs.writeFileSync(path.join(srcDir, 'target.txt'), 'normal-file');
    let made = false;
    try {
      fs.symlinkSync(path.join(srcDir, 'target.txt'), path.join(srcDir, 'link.txt'));
      made = true;
    } catch {
      /* platform menolak (Windows tanpa developer-mode/privilege) */
    }
    try {
      fs.symlinkSync(tmpRoot, path.join(srcDir, 'dirlink'), 'dir');
      made = true;
    } catch {
      /* sama */
    }
    if (!made) {
      t.skip('pembuatan symlink ditolak platform — jalur skip tidak dapat diverifikasi di sini');
      return;
    }
    copyWorkspaceFiles(srcDir, destDir, { ignoreEnv: true });
    assert.ok(fs.existsSync(path.join(destDir, 'app.js')), 'file biasa tetap disalin');
    assert.ok(fs.existsSync(path.join(destDir, 'target.txt')), 'target asli (file biasa) tetap disalin');
    assert.ok(!fs.existsSync(path.join(destDir, 'link.txt')), 'symlink file TIDAK boleh disalin/diikuti');
    assert.ok(!fs.existsSync(path.join(destDir, 'dirlink')), 'symlink dir TIDAK boleh diikuti/dibuat');
  });

  test('upsertEnvFile: key non-identifier ditolak; value strip \\r/\\n cegah injeksi baris (A2#25)', () => {
    const dir = path.join(tmpRoot, 'env-a225');
    fs.mkdirSync(dir, { recursive: true });
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, '# comment\nKEEP=orig\n');
    upsertEnvFile(envPath, {
      KEEP: 'v1',
      'EVIL KEY': 'x',
      '1BAD': 'y',
      'INJECT2': 'line1\r\nINJECTED=boom\nline3',
    });
    const out = fs.readFileSync(envPath, 'utf8');
    assert.match(out, /# comment/, 'komentar dipertahankan');
    assert.match(out, /^KEEP=v1$/m, 'key lama diganti in-place');
    assert.match(out, /^INJECT2=line1 INJECTED=boom line3$/m, 'newline di value diluruskan jadi satu baris');
    assert.ok(!/^INJECTED=boom$/m.test(out), 'baris hasil injeksi TIDAK boleh berdiri sendiri');
    assert.ok(!out.includes('EVIL'), 'key berisi spasi ditolak');
    assert.ok(!out.includes('1BAD'), 'key diawali angka ditolak');
  });
});


