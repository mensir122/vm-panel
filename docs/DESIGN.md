# VM Deployment Manager — Dokumen Desain (Draft untuk Review)

> STATUS: DRAFT — menunggu review arsitektur dan persetujuan pemilik sistem.
> Aturan ground: sistem 100% fresh. Tidak ada koneksi data/credential/repo/bot/panel lama.

---

## Daftar Isi
1. Ringkasan Requirement
2. Desain Arsitektur
3. Diagram Komponen
4. Struktur Folder Final
5. Model Database
6. Model Service Lifecycle
7. Model Deployment Lifecycle
8. Model Recovery State Machine
9. Model Backup & Retention
10. Model Export/Import
11. Model Permission
12. Threat Model
13. Rencana Secret Management
14. Rencana Audit Logging
15. Rencana Self-Chain
16. Rencana Runner Migration
17. Rencana Migrasi ke VPS Nyata
18. Rencana Testing
19. Rencana Failure Simulation
20. Risiko GitHub Actions
21. Keterbatasan Sistem
22. Daftar Keputusan yang Butuh Persetujuan

---

## 1. Ringkasan Requirement

### 1.1 Apa yang dibangun
VM Deployment Manager ("VPANEL") = control plane + runtime plane untuk mengelola banyak project di satu host (GitHub Actions runner ephemeral sekarang, VPS nyata nanti), layaknya VPS pribadi.

Tiga konstituen sistem:
1. **Manager** — daemon headless: service/project/deployment/health/recovery/backup/restore/rollback/export/import/audit/permission/secret/lock/resource. Satu-satunya penulis ke database.
2. **Panel** — web UI terpisah dari manager: auth sendiri (session cookie + TOTP + recovery codes), permission sendiri, database sendiri (panel.db), audit sendiri. Panel TIDAK pernah bagian dari project yang dikelola. Panel memanggil manager via API lokal terautentikasi.
3. **vmctl** — CLI: `vmctl <noun> <verb>` (system/project/service/deployment/backup/export/import/health/recovery/audit). Aksi destruktif = two-phase confirm.

### 1.2 Driver teknis
- Node.js ≥ 20, zero-dependency core (child_process + fs + crypto bawaan). Alasan: runtime tersedia di GitHub Actions runner tanpa pre-install, buildless, mengurangi supply-chain attack surface, dan mengurangi kebutuhan pin-dependency audit. Dua modul panel opsional. SATU dependency ter-pin untuk database: `better-sqlite3` (exact version di lockfile) — karena `node:sqlite` bawaan baru ada sejak Node 22.5 (experimental) dan belum stabil bahkan di Node 24, sedangkan Node 20 LTS tidak memilikinya sama sekali (hasil verifikasi riset). better-sqlite3 mendukung WAL, online backup API, `VACUUM INTO`, `integrity_check`.
- Matriks target: (a) GitHub Actions ubuntu-latest sebagai host, (b) Ubuntu VPS, (c) container Docker.
- Worker pool: 4 lane worker async untuk menjalankan project bersamaan (proyeksi 8-30 project aktif).

### 1.3 Cakupan 100% vs ditunda (butuh persetujuan)
**Cakupan 100% (dijamin diuji nyata, bukan hanya dokumentasi):**
- Fresh-start guarantee: bootstrap menolak folder non-kosong.
- Auto-recovery supervisor internal + crash-loop + exponential backoff 5s/15s/30s/60s/120s.
- Auto-restart: on-failure dengan restart limit (default 5).
- Health check multi-type (HTTP/TCP/command/DB/process) + timeout/retry/consecutive-failure.
- Backup atomic: SQLite backup API (`VACUUM INTO` — snapshot konsisten di mode WAL) → manifest.json → archive (gzip per-file / tar sistem dengan round-trip test — BUKAN tar writer buatan sendiri) → SHA-256 → verify.
- 9 database SQLite: platform, projects, services, deployments, health, backups, audit, users, locks.
- Tabel `schema_migrations` + runner migrasi.
- Tabel `meta` dengan versionable config, diff-only update.
- Rollback manager: marker sukses/fail; unset marker → timeout rollback otomatis.
- Export/import project/all + encrypted (AES-256-GCM, password PBKDF2 600k iter).
- Permission model RBAC + scoping per-project + owner-only list.
- Audit append-only + 22 field + redaction.
- Security hardening: path traversal, command injection (exec argv no-shell), port collision, symlink escape, archive traversal, CSRF (double-submit cookie), rate-limit + lockout, session expiry, admin approval flow, permission cache 60s.
- Resource: PM2-like modul proksi adaptif dengan capability check + sandboxing per platform.
- Self-chain: workflow_dispatch + GITHUB_TOKEN + workflow keepalive/lockfile + twin workflow safeguard.
- Testing 75 kategori test wajib (unit/integration/security/recovery).

**Ditunda (butuh persetujuan eksplisit, diimplementasi pada fase berikutnya):**
- Arsitektur multi-host (fleet manager + worker node) — out of scope fase ini.
- Rekomendasi resource otomatis dari baseline statistik — fase observability lanjutan.
- Orkestrasi Docker-style (auto-select adapter) — sekarang manual.
- Fitur komentar commit yang mengandung secret (deteksi secret pada commit baru) — pengayaan, bukan inti.
- Dashboard logika multi-host.
- Rename system berbeda untuk vps.yml vs vm.yml — perlu konfirmasi.

### 1.4 Out of scope
- Membaca/menghubungkan sistem lama dalam bentuk apa pun (Hermes lama, 9Router lama, bot lama, panel lama, DB lama). Semua data uji = dummy.
- Mendeploy project "production" milik pengguna — hanya project dummy/test.
- Menjalankan server Minecraft berat di runner GitHub Actions — hanya verify-command.

### 1.5 Terminologi
| Term | Definisi |
|---|---|
| Project | Unit deployable: kode + config + lifecycle. ID `prj_<base32>` |
| Service | Instance proses berjalan dari sebuah project (bisa >1 per project). ID `svc_<base32>` |
| Workspace | Direktori hasil clone/build sebuah project |
| Runner | Host ephemeral yang menjalankan manager + supervisor (GitHub Actions sekarang) |
| Deployment | Satu percobaan deploy dengan ID unik + revision |
| Crash-loop | Service yang gagal N kali berturut-turut melewati restart limit |
| Migration | Perpindahan state manager antar runner ephemeral (self-chain) atau ke VPS |
| Secret | Nilai sensitif (token, password, key). Disimpan encrypted-at-rest; direferensikan via `secret://name` |

---

## 2. Desain Arsitektur

### 2.1 Layering
```
┌──────────────────────────────────────────────────────────────┐
│ Clients: vmctl (CLI) │ Panel Web │ GitHub Actions workflow    │
└───────┬────────────────┬──────────────┬───────────────────────┘
        │  localhost API (HTTPS bearer token)                  │
┌───────▼────────────────▼──────────────▼───────────────────────┐
│ MANAGER (daemon headless Node.js)                             │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ │
│ │ Project    │ │ Deployment │ │ Service    │ │ Health      │ │
│ │ Manager    │ │ Manager    │ │ Manager    │ │ Manager     │ │
│ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └──────┬─────┘ │
│       └───────────────┴──────────────┴───────────────┘       │
│                    Dispatcher + Worker Pool (4)                │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ │
│ │ Backup     │ │ Recovery   │ │ Audit      │ │ Permission │ │
│ │ Manager    │ │ Manager    │ │ Manager    │ │ Manager    │ │
│ └────────────┘ └────────────┘ └────────────┘ └────────────┘ │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐                 │
│ │ Secret     │ │ Lock      │ │ Resource   │                 │
│ │ Manager    │ │ Manager    │ │ Manager    │                 │
│ └────────────┘ └────────────┘ └────────────┘                 │
│ SQLite (WAL) × 9 DB ── hanya manager yang menulis             │
└───────┬──────────────────────────────────────────────────────┘
        │ child_process (per-service proksi OS-specific, no shell)
┌───────▼──────────────────────────────────────────────────────┐
│ PROJECT RUNTIMES (workers): static/node/python/docker/mc-     │
│ java/mc-bedrock/bots/hermes/router/custom ── isolated dirs    │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Proses & model eksekusi
| Proses | Peran |
|---|---|
| `manager` (node) | Satu-satunya penulis DB; mengelola lifecycle; worker pool internal |
| `supervisor-external` | Watchdog: memantau manager + panel; me-restart jika mati (exit<0, SIGKILL, crash). Implementasi: script node kecil + systemd unit di VPS / step berulang di workflow |
| `supervisor-internal` | Loop di dalam manager: monitor PID/port/health/crash-loop → restart dengan backoff |
| `panel` (node) | Web server terpisah, database panel.db sendiri |
| Project processes | Dijalankan manager via child_process, env terisolasi, resource di-limit |

### 2.3 API Manager (localhost only)
- Listen `127.0.0.1:<MANAGER_API_PORT>` (default 8097), HTTP (bukan HTTPS — kompleksitas self-signed loopback tidak sepadan; loopback tidak tersniff dari luar) + bearer token (secret).
- Endpoint groups: /system, /projects, /services, /deployments, /backups, /exports, /health, /recovery, /audit, /users, /permissions.
- Panel dan vmctl memanggil API ini (loopback). Tidak pernah diekspos ke publik — saat VPS, dilindungi reverse proxy + firewall.
- CLI fast-path: untuk status/log, vmctl boleh langsung membaca SQLite read-only + file (menghindari overhead saat manager mati).

### 2.4 Prinsip arsitektur
1. **Single-writer per DB**: hanya manager menulis; panel hanya menulis ke panel.db miliknya; CLI/panel membaca via API.
2. **Isolasi**: setiap project punya workspace, env, secret scope, port, lock terpisah; PID file di runtime/pid.
3. **Everything must die**: setiap proses punya stop procedure + kill timeout + verification; tidak ada proses yatim.
4. **Fresh-start guarantee**: bootstrap memvalidasi `platform.db` atau folder kosong; menolak struktur asing → mencegah sistem lama terbaca.
5. **Anti-delete**: tidak ada fungsi otomatis yang menghapus DB valid; semua destructive = backup → tombol manual → confirm dua tahap.
5. **Driver dependency pinning**: package.json memakai `engines: {node: ">=20"}` dan dependency di-pin exact-version; `npm ci` + lockfile commit. Satu dependency produksi: `better-sqlite3` (lihat §1.2).
6. **Testing Offline First**: unit tests tanpa internet; adapter real deploy dirancang dry-run-able untuk CI tanpa internet penuh.
7. **Migratable**: tidak ada coupling ke filesystem khusus GitHub Actions; semua path berbasis config; abstraksi `Platform` untuk systemd/Docker/K8s.

### 2.5 Modul manager (16 modul)
| Modul | Tanggung jawab |
|---|---|
| ServiceManager | Orkestrasi lifecycle service: create/install/prepare/configure/start/stop/restart/status/health/logs/enable/disable/remove/archive/restore |
| ProjectManager | CRUD project, registry, workspace, metadata, status |
| DeploymentManager | Jalankan adapter pipeline, lock per-project, retry, rollback, catat deployment record |
| ProcessManager | Spawn/kill proses, PID file, exit code tracking, resource sampling (ps) |
| HealthManager | HTTP/TCP/cmd/DB/process checks + timeout/retry/consecutive-failure → update health.db |
| RecoveryManager | State machine recovery (lihat §8), backoff, crash-loop detection, notifikasi threshold |
| BackupManager | Lock global+project, checkpoint DB, manifest, archive, checksum, verify, upload, metadata |
| RestoreManager | Verifikasi backup, integritas DB, atomic restore, rollback point |
| RollbackManager | Revision pointer, deployment markers, auto-rollback deployment terputus |
| ExportManager | Project/all export, manifest, checksum, optional encryption (AES-256-GCM) |
| ImportManager | Validasi archive/manifest/checksum/schema, tolak traversal, rollback point, atomic import |
| AuditManager | Append-only audit events, redaction, owner-only purge (2-konfirmasi) |
| PermissionManager | RBAC owner/operator/viewer + scoping per-project + cache 60s |
| SecretManager | AES-256-GCM encrypted-at-rest + env injection + redaction + rotation hook |
| LockManager | File locks di runtime/locks: global/deploy-<id>/backup-<id>/project-<id> |
| ResourceManager | CPU/RAM/disk/process limit enforcement, sampling, storage monitor |

### 2.6 Adapters (13 tipe)
| Adapter | prepare/install/configure/start khas |
|---|---|
| static | copy build output → serve via manager embedded static server (subdomain/subpath) |
| node | npm ci (pinned lockfile) → node entrypoint; health via HTTP |
| python | venv per project → pip install (pinned requirements.txt) → exec entrypoint |
| docker | docker compose up -d (ignore-orphan) ; adapter verify via docker inspect |
| minecraft_java | unduh server.jar (dummy versi untuk test), eula dummy, java -jar |
| minecraft_bedrock | unduh bedrock binary, ulimit tweak |
| telegram | polling getUpdates / webhook; token via secret ref; dummy token untuk test |
| whatsapp | session via encrypted store; dummy creds untuk test |
| discord | gateway ws; dummy token; JS runtime shared dengan node adapter |
| hermes | agent runner: clone repo dummy, npm ci, start; secret via env |
| router (9Router) | node runtime; config.yaml ditemplate; port binding |
| rest-api | tipe node atau python + contract health endpoint; port + swagger optional |
| custom | user-defined start command + validator command allow-list |

Interface adapter (semua wajib): `detect(), validate(), prepare(), install(), configure(), start(), stop(), restart(), status(), health_check(), logs(), cleanup(), export_state(), restore_state()` — dipanggil DeploymentManager dengan error isolation per adapter.

### 2.7 Worker pool model
- Manager menjalankan hingga 4 worker lane paralel (async) untuk deployment/start/health-check batch.
- Setiap worker: nama unik (worker-1..4), satu job pada satu waktu, job queue di table `deployment_queue` (services.db), lock per project → tidak ada dua deployment bersamaan untuk project yang sama.
- Jika queue penuh > 32: reject dengan `QUEUE_FULL`, audit event.

### 2.8 Notifikasi
- Threshold crash-loop/recovery/backup-failure → notifikasi via webhook terkonfigurasi (dummy endpoint untuk test) + audit event. Tidak ada ketergantungan pada bot yang dikelola sistem ini.

---

## 3. Diagram Komponen

### 3.1 Component diagram (teks)
```
                    ┌────────────────────────────┐
                    │   GitHub Actions Runner    │
                    │  (ephemeral host, ubuntu)  │
                    └───────┬──────────────┬──────┘
                            │              │
              vm.yml workflow│              │vm.yml self-chain dispatch
                            ▼              ▼
┌──────────────────────────────────────────────────────────┐
│ External Supervisor (workflow step + watchdog script)    │
│  - monitor manager pid                                   │
│  - monitor panel pid                                     │
│  - restart-on-death                                      │
└───────────────┬──────────────────────────────────────────┘
                │ spawn/restart
┌───────────────▼───────────────┐  ┌────────────────────────┐
│ MANAGER DAEMON                │  │ PANEL (web)            │
│ 16 modul + worker pool        │  │ - panel.db sendiri     │
│ 9 SQLite DB (WAL)             │◄─┤ - auth: session+TOTP   │
│ adapters: 13 tipe             │  │ - audit sendiri        │
│ runtime/pid,locks,sockets     │  │ - UI hitam profesional │
└───────┬───────────────────────┘  └────────────────────────┘
        │ child_process (no shell, no PATH lookup)
┌───────▼──────────────────────────────────────────────────┐
│ Project services (isolated)                               │
│ [static-1] [node-api] [py-bot] [mc-java] [hermes] [router]│
└──────────────────────────────────────────────────────────┘
        ▲ logs, health, resource sampling (read-only)
```

### 3.2 Deployment sequence
```
vmctl project deploy prj_x
  → Manager: lock project → create deployment row (dep_id)
  → adapter.detect → validate → prepare → install → configure
  → stop old service (graceful) → start new (spike) → health probe
  → healthy? ──► marker success + audit + unlock
  │             └─► stop new (rollback), keep old (if healthy before), audit FAIL
  └► timeout/fail → unset marker → RollbackManager auto-rollback
```

### 3.3 Component dependency (build order)
```
SDK: lib/platform (fs+lock+proc+redaction) → lib/db (tx+migrate+WAL) →
manager core (16 modul) → adapters → vmctl → panel → tests → workflows → docs
```

---

## 4. Struktur Folder Final

Sesuai permintaan (struktur user dipertahankan, penyesuaian teknis dijelaskan):

```text
VM-Panel/                  # nama folder = folder kerja ini (keputusan user)
├── panel/
│   ├── server/                 # server.js, routes, middleware
│   ├── static/                 # CSS, JS vanilla, fonts system, logo.svg
│   ├── templates/              # HTML templates (SSR, tanpa framework)
│   ├── assets/
│   └── config/                 # panel.yaml
├── manager/
│   ├── service_manager/
│   ├── project_manager/
│   ├── deployment_manager/
│   ├── process_manager/
│   ├── health_manager/
│   ├── recovery_manager/
│   ├── backup_manager/
│   ├── restore_manager/
│   ├── rollback_manager/
│   ├── export_manager/
│   ├── import_manager/
│   ├── audit_manager/
│   ├── permission_manager/
│   ├── secret_manager/
│   ├── lock_manager/
│   ├── resource_manager/
│   └── adapters/               # PENYESUAIAN: adapter tinggal di dalam manager/ karena adapter dipanggil langsung oleh DeploymentManager; folder adapters/ top-level dipindah ke sini
├── templates/                  # project templates (boilerplate per tipe)
│   ├── static/ node/ python/ docker/ minecraft/ bot/ hermes/ router/ custom/
├── projects/
│   ├── registry/               # project-<id>.yaml (metadata, tanpa secret)
│   ├── active/ stopped/ failed/ archived/ workspaces/
├── runtime/
│   ├── pid/ locks/ sockets/ health/ environments/ processes/ temporary/
├── logs/
│   ├── panel/ manager/ deployment/ recovery/ audit/ projects/
└── data/                       # 9 database SQLite + migrations/
├── backups/
│   ├── latest/ daily/ weekly/ manual/ failed/ exports/
├── secrets/                    # vault.enc (AES-256-GCM), .gitkeep, secrets.yaml (refs)
├── scripts/                    # bootstrap.sh, start_manager.sh, stop_manager.sh,
│                               # health_check.sh, recovery_check.sh, backup.sh, restore.sh
├── tests/
│   ├── unit/ integration/ security/ recovery/ fixtures/
├── .github/workflows/          # vm.yml, backup.yml, recovery.yml
├── lib/                        # SDK internal: platform/db (PENYESUAIAN: shared lib)
├── bin/vmctl.js                # CLI entrypoint (PENYESUAIAN: bin/ untuk PATH)
├── config.yaml, .env.example, .gitignore, README.md, AGENTS.md
```

### Penyesuaian vs struktur user (dengan alasan teknis):
1. **`adapters/` top-level → `manager/adapters/`**: adapters adalah implementation detail DeploymentManager (dipanggil langsung, error-isolated). Menjaga top-level bersih dan dependency satu arah. Symlink tidak dipakai demi portabilitas Windows dev machine.
2. **`lib/` baru**: modul berbagi (db core, platform abstraction) supaya manager/panel/vmctl/tests tidak duplikasi kode.
3. **`bin/vmctl.js`**: entrypoint standar npm `bin` field → bisa dipanggil `npm run vmctl -- project list` atau global via `npm i -g`.
4. **`data/migrations/`**: SQL + JS migration runner terpisah dari file DB untuk kejelasan.
5. **Panel SSR tanpa framework** (templates/ + static/): tanpa CDN eksternal, no-build, sesuai UI spec hitam profesional.
6. **Nama folder project = `VM-Panel`** — sama dengan folder kerja yang sudah ada (keputusan user; alternatif `vm-deployment-manager` ditolak).

---

## 5. Model Database

### 5.1 Ringkasan 9 DB SQLite (mode WAL, single-writer = manager)
| DB | Isi utama |
|---|---|
| platform.db | meta config, migrations, runner state, storage stats |
| projects.db | projects, project_env_refs, workspaces |
| services.db | services, service_supervisor_state, deployment_queue |
| deployments.db | deployments, deployment_events, revisions |
| health.db | health_checks, health_state, alerts |
| backups.db | backups, backup_items, retention_runs |
| audit.db | audit_events (append-only), audit_purge_requests |
| users.db | users, sessions, recovery_codes, totp_secrets |
| locks.db | lock_registry (metadata), lock_events |

### 5.2 ERD (teks)
```
projects 1──N services 1──N health_checks
projects 1──N deployments 1──N deployment_events
projects 1──N backups 1──N backup_items
projects 1──1 workspaces
services 1──1 service_supervisor_state (restart_count, backoff_until, crash_loop)
users 1──N sessions, 1──N recovery_codes, 1──1 totp_secrets
users N──M projects (project_scopes)
audit_events: standalone (actor, target, before/after, result)
```

### 5.3 Skema inti (SQL DDL ringkas)
```sql
-- platform.db
CREATE TABLE meta (key TEXT PK, value TEXT NOT NULL, updated_at TEXT NOT NULL);  -- versionable config
CREATE TABLE schema_migrations (version INTEGER PK, name TEXT, applied_at TEXT);
CREATE TABLE runner_state (id TEXT PK, phase TEXT, started_at TEXT, expires_at TEXT,
  self_chain_pid TEXT, chain_depth INTEGER, watchdog_seen TEXT);
CREATE TABLE storage_stats (id INTEGER PK, total_bytes, used_bytes, free_bytes,
  est_full_at TEXT, captured_at TEXT);

-- projects.db
CREATE TABLE projects (
  id TEXT PK, name TEXT UNIQUE, type TEXT, status TEXT,           -- 24 metadata field user
  repo_url TEXT, repo_owner TEXT, repo_name TEXT, branch TEXT, revision TEXT,
  workspace_path TEXT, runtime_path TEXT,
  start_cmd TEXT, stop_cmd TEXT, restart_cmd TEXT, health_cmd TEXT, health_url TEXT, port INTEGER,
  env_ref TEXT, secret_ref TEXT, pid_file TEXT, log_file TEXT,
  resource_limits TEXT,  -- JSON {cpu,ram,disk,processes}
  restart_policy TEXT,   -- JSON {mode,on_failure,max_retries,backoff_s}
  deployment_policy TEXT, backup_policy TEXT,
  last_deployment_id TEXT, last_health_at TEXT, last_recovery_at TEXT,
  created_at TEXT, updated_at TEXT, archived_at TEXT
);
CREATE TABLE project_env_refs (project_id, env_name, secret_ref);  -- env mapping, values NEVER di sini

-- services.db
CREATE TABLE services (
  id TEXT PK, project_id REFERENCES projects(id), name TEXT, status TEXT,
  pid INTEGER, port INTEGER, enabled INTEGER, restart_count INTEGER,
  last_exit_code INTEGER, started_at TEXT, updated_at TEXT
);
CREATE TABLE service_supervisor_state (
  service_id TEXT PK, state TEXT, restart_count INTEGER, backoff_until TEXT,
  crash_loop INTEGER, consecutive_failures INTEGER, last_event TEXT, updated_at TEXT
);
CREATE TABLE deployment_queue (id TEXT PK, project_id, job_type, payload TEXT,
  status TEXT, worker TEXT, enqueued_at, started_at, finished_at);

-- deployments.db
CREATE TABLE deployments (
  id TEXT PK, project_id, revision TEXT, actor TEXT, status TEXT,   -- pending/running/success/failed/rolled_back
  stage TEXT, error TEXT, started_at TEXT, finished_at TEXT, rollback_of TEXT
);
CREATE TABLE deployment_events (id INTEGER PK, deployment_id, stage, status,
  detail TEXT, at TEXT);
CREATE TABLE revisions (project_id, revision, source TEXT, marker TEXT, at TEXT);

-- health.db
CREATE TABLE health_checks (
  id INTEGER PK, project_id, service_id, check_type, at TEXT, latency_ms INTEGER,
  result TEXT, status TEXT, error TEXT, consecutive_failures INTEGER, recovery_action TEXT
);
CREATE TABLE health_state (service_id TEXT PK, status TEXT, last_check_at TEXT,
  last_healthy_at TEXT, consecutive_failures INTEGER);
CREATE TABLE alerts (id INTEGER PK, project_id, level TEXT, code TEXT, message TEXT, at TEXT, resolved_at);

-- backups.db
CREATE TABLE backups (
  id TEXT PK, project_id, at TEXT, trigger TEXT, file_path TEXT, file_size INTEGER,
  sha256 TEXT, db_status TEXT, upload_status TEXT, verification_status TEXT,
  retention_class TEXT, runner_id TEXT, error TEXT
);
CREATE TABLE backup_items (backup_id, path, size, sha256);
CREATE TABLE retention_runs (id INTEGER PK, at TEXT, class TEXT, deleted_count INTEGER, kept_count INTEGER, detail TEXT);

-- audit.db (append-only; DELETE di-disable via trigger)
CREATE TABLE audit_events (
  id INTEGER PK AUTOINCREMENT, at TEXT, actor TEXT, user_id, role, project_id, service_id,
  operation TEXT, input_json TEXT,  -- sanitized
  status_before, status_after, revision_before, revision_after, pid_old, pid_new, port INTEGER,
  backup_id, deployment_id, runner_id, recovery_action, error TEXT, result TEXT
);
CREATE TRIGGER no_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only'); END;

-- users.db
CREATE TABLE users (id TEXT PK, username TEXT UNIQUE, password_hash TEXT, role TEXT,
  totp_secret TEXT,  -- encrypted-at-rest
  status TEXT, failed_attempts INTEGER, locked_until TEXT, created_at TEXT, last_login_at TEXT);
CREATE TABLE sessions (id TEXT PK, user_id, created_at, expires_at, csrf_token TEXT, revoked INTEGER);
CREATE TABLE recovery_codes (id INTEGER PK, user_id, code_hash TEXT, used_at TEXT);
```

### 5.4 Isolasi & partisi DB
- Kenapa 9 DB bukan 1: (1) backup granular per domain, (2) lock contention rendah (audit.db dan health.db adalah hot path), (3) sesuai permintaan struktur user, (4) blast radius corrupt lebih kecil.
- Setiap DB punya `schema_migrations` sendiri + version. Foreign key lintas-DB tidak dimungkinkan SQLite → konsistensi dijaga dengan:
  - **ProjectLifecycleOrchestrator**: delete/archive project = urutan compensating actions lintas-DB (services → deployments → health → backups-ref → projects) dengan jurnal langkah; gagal di tengah → lanjut/rollback saat retry (idempotent).
  - **Backupset epoch**: setiap DB menyimpan `backupset_epoch` di meta; backup menulis epoch sama ke semua DB; restore MENOLAK set dengan epoch campuran (mencegah backups.db lama + projects.db baru → orphan backup_id).
  - **Integrity job periodik**: deteksi orphan reference lintas-DB (deployment tanpa project, backup_id tanpa backup, service tanpa project) → alert + laporan, TIDAK auto-delete.

### 5.5 Migrasi & recovery prosedur per-DB (implementasi nyata di lib/db)
1. **Schema version + migration runner**: tabel `schema_migrations`, runner transaksional (setiap migration dalam BEGIN…COMMIT, gagal → ROLLBACK dan sistem refuse-start).
2. **Integrity check**: `PRAGMA integrity_check` + `PRAGMA foreign_key_check` saat startup, restore, import, backup (pre+post).
3. **Backup**: SQLite Online Backup API (`VACUUM INTO` — snapshot transaksional konsisten walau ada writer, terverifikasi untuk mode WAL; catatan: file tujuan tidak boleh sudah ada; `synchronous=NORMAL/FULL` agar durable) atau `db.backup()` better-sqlite3 — bukan copy file mentah.
4. **WAL/SHM stale handling**: saat start, jika `-wal`/`-shm` ada tapi no live writer → checkpoint + remove stale (dengan backup salinan dulu ke temporary).
5. **Empty-file detection**: file DB 0-byte atau header != `SQLite format 3\0` → refuse start, bukan auto-delete; instruksi manual restore.
6. **Bukan-SQLite detection**: header check idem.
7. **FK failure detection**: foreign_key_check nonzero → quarantine (rename `.corrupt`), restore dari backup terakhir valid, jalankan recovery log.
8. **Corrupt recovery alur** (sesuai §9 user): stop writer → backup newest → copy ke temp → integrity_check → `.recover` salvage pada salinan → verifikasi → rollback copy → atomic rename → migration → integrity ulang → audit catat. DB valid asli TIDAK PERNAH dihapus otomatis.
9. **Locking**: busy_timeout 5000 + WAL normal mode + IMMEDIATE transactions; lock global backup memakai LockManager.

---

## 6. Model Service Lifecycle

### 6.1 State machine service
```
                ┌────────────┐
      create ──►│  CREATED   │
                └─────┬──────┘
                install/prepare/configure
                ┌─────▼──────┐   enable    ┌─────────┐
                │  STOPPED   │◄────────────►│ DISABLED│
                └─────┬──────┘              └─────────┘
                 start│  ▲ stop/restart     (disable = tidak auto-start,
                ┌─────▼──────┐             tidak dipickup supervisor)
                │  STARTING  │
                └─────┬──────┘
             spawn OK │        spawn fail
                ┌─────▼──────┐      ┌──────────┐
                │  RUNNING   │─────►│  FAILED   │──restart policy──► STARTING
                └─────┬──────┘      └──────────┘
                      │ health probe
        ┌─────────────┼─────────────┐
   healthy        degraded        unhealthy
        │             │               │
   HEALTHY       DEGRADED     ┌───────▼────────┐ recovery window
   (sub-state)  (sub-state)  │ RECOVERING     │──backoff→STARTING
                               └───────┬────────┘   restart limit reached
                                       └────────► CRASH_LOOP (manual retry only)
archive/remove: terminal → ARCHIVED / REMOVED
```
Sub-state status: RUNNING-HEALTHY / RUNNING-DEGRADED (health ok tapi resource > soft limit) / STARTING dengan health pending.

### 6.2 Operasi lifecycle (ServiceManager)
| Operasi | Precondition | Efek |
|---|---|---|
| create | project valid, ID unik, nama unik | status CREATED |
| install | adapter.validate() lulus | deps terpasang di workspace |
| prepare | install OK | workspace siap (template/copy) |
| configure | prepare OK | config + env + secret resolved |
| start | status STOPPED/FAILED, port bebas, quota cukup | spawn, PID file, status STARTING→RUNNING |
| stop | PID hidup atau status RUNNING | graceful stop → SIGTERM, tunggu 10s → SIGKILL, verify |
| restart | status apapun kecuali ARCHIVED | stop lalu start, preserve exit-code ctx |
| status | — | baca PID+health+resource snapshot |
| health | — | HealthManager probe on-demand |
| logs | — | tail log_file (tail -n, follow optional) |
| enable/disable | — | toggle auto-start & supervisor pickup |
| remove | konfirmasi 2x, hanya owner | workspace+registry dihapus, backup tetap |
| archive | konfirmasi 2x | pindah registry/active→archived, stop service |
| restore | dari archived | kembali ke stopped |

### 6.3 PID & process tracking
- PID file: `runtime/pid/<service-id>.pid` — ditulis atomik setelah spawn, dihapus saat confirmed-dead.
- Exit code tracking: `runtime/processes/<service-id>.json` {pid, exit_code, started_at, stopped_at} — update saat exit event (detach/residual exit listener).
- Zombie/gone detection: supervisor cek process existence tiap tick; PID reuse mitigation: di Linux baca `/proc/<pid>/stat` field 22 (starttime) langsung dan bandingkan dengan starttime saat spawn (lebih andal dari parsing `ps`); fallback `ps` untuk platform lain.

### 6.4 Restart policy per service
```json
{ "mode": "on-failure|always|never", "max_retries": 5, "backoff_base_s": 5,
  "backoff_seq": [5,15,30,60,120], "restart_window_s": 600 }
```
- on-failure: exit != 0 → restart dengan backoff sequence; window reset jika stabil 600s.
- always: restart bahkan exit 0 (untuk always-on project seperti panel-facing bot).
- never: tidak auto-restart (mis. one-shot cron/migration).

### 6.5 Enable/Disable
- `enabled=false` → supervisor tidak memproses, tidak auto-start saat runner restore, tidak dihitung crash-loop.
- Tabel services.enabled + status DISABLED.

---

## 6A. Model Resource Isolation & Limits
(Fitur "Batasan CPU/RAM/disk/proses" + host binding)

### 6A.1 Resource quota per service
```json
{ "cpu_percent": 50, "ram_mb": 512, "disk_mb": 2048, "max_processes": 40 }
```
- cpu_percent / max_processes: diimplementasikan via dua provider adaptif:
  - **POSIX (utama)**: `systemd-run --scope -p CPUQuota= -p MemoryMax= -p TasksMax= -p IOReadBandwidthMax=` — native, berlaku pada seluruh subtree proses. Gotcha terverifikasi: butuh systemd berjalan (root, atau `--user` + cgroup delegation); cgroup v2 disarankan; `MemoryMax` MEMBUNUH proses (bukan throttle) → dijadikan hard-limit handler; capability-check saat startup → jika systemd tak tersedia (mis. container tanpa systemd) → fallback advisory + audit WARNING.
  - **Windows**: **Windows Job Objects** — worker menempatkan proses di Job dengan CPU rate control, memori/disk/proses-limit job, dan kill loop jika melebihi; capability-check saat startup → jika tidak didukung, fallback tanpa-limit + audit WARNING `resource_limits_not_enforced`.
- Disk mb: quota soft — ResourceManager sampling `du` workspace+logs per interval; > soft → alert; > hard → suspend service + audit.
- Sampling resource usage (top-N): interval 5s — baca `/proc/<pid>` (Linux) / Job Objects (Windows) → tulis ke health.db `resource_samples`.
- Over-limit policy: soft → alert + audit; hard (2× soft selama 3 sampel) → SIGSTOP lalu stop service, audit `resource_hard_limit`.

### 6A.2 Port allocation & host binding
- Registry port: services.db `ports` table (port INTEGER UNIQUE, service_id, bound_host, bound_at).
- Allocation: manager memilih port bebas 10000-65535 (range configurable), dua aturan penting:
  - **Reserved ranges**: port < 1024 → ditolak (unprivileged).
  - **Collision check**: bind-test sebelum start (TOCTOU diakui: bind test ≠ bind child; mitigasi: child gagal bind → service FAILED + audit, bukan silent); dua project sama port → konflik terdeteksi di level config + level bind.
  - **Anti port-leak**: registrasi port di-release otomatis saat service exit/failed/remove; job rekonsiliasi periodik (5 menit) membandingkan registry vs port aktual (`ss -ltn`) → port yatim dihapus + audit.
- Host binding default: `127.0.0.1` (project TIDAK langsung expose). Eksposur via:
  - Reverse proxy (panel/manager domain mapping), atau
  - `--public` flag per project (VPS mode, config) — audit + firewall rule otomatis.
- Illegal port (0, <1024, >65535, port panel/manager) → error `PORT_ILLEGAL`, audit.

### 6A.3 Environment & global-env protection
- **EnvFile per project**: `runtime/environments/<project-id>.env` — berisi HANYA var milik project (secret_resolved values); file mode 600; tidak pernah di-commit; di-include ke export HANYA jika `--encrypted`.
- **Global env whitelist**: variabel sistem yang boleh diteruskan: PATH, HOME, LANG, LC_*, TZ, NODE_*(safe subset), TMPDIR. Selain whitelist → DROPPED (audit `env_dropped`).
- **Env precedence**: project env > adapter defaults > minimal-OS-baseline. Tidak ada var global OS lain yang bocor ke project (mencegah `MENGAKSES ENVIRONMENT VARIABLE GLOBAL SECARA SEMBARANGAN`).
- Secret values di-inject via `secret://` refs → SecretManager resolve saat spawn → env var + child never logs (redaction).

### 6A.4 Worker pool concurrency & fault isolation
- Manager menjalankan hingga 4 worker lane paralel (async) untuk deployment/start/health-check batch.
- Setiap worker: nama unik, satu job pada satu waktu, job queue di table `deployment_queue` (services.db), lock per project → tidak ada dua deployment bersamaan untuk project yang sama.
- Jika queue penuh > 32: reject dengan `QUEUE_FULL`, audit event.
- Fault isolation: satu project gagal deploy tidak mengganggu worker lain — error tertangkap per-job, worker tetap hidup.

---

## 7. Model Deployment Lifecycle

### 7.1 Pipeline deployment (adapter interface)
```
detect() → validate() → prepare() → install() → configure()
→ [stop old service] → [start new] → health_check() → marker
```
Setiap tahap menghasilkan `deployment_events` row; gagal → status FAILED + stage terakhir disimpan + error lengkap.

### 7.2 State machine deployment
```
PENDING → RUNNING(stage=detect…) → SUCCESS
                                   ↘ FAILED → RETRY_PENDING → RUNNING…
                                   ↘ ROLLED_BACK
```
- Deployment ID: `dep_<base32>`; revision = commit SHA (git) atau `tpl-<template>` (template).
- Duplicate guard: lock project selama deployment; deploy kedua ditolak `DEPLOY_IN_PROGRESS` (bukan antre menunggu) — dua deployment bersamaan project sama = mustahil.
- Retry: `vmctl deployment retry dep_x` → deployment baru dengan `rollback_of`/`retry_of` link.
- Rollback: `vmctl deployment rollback dep_x` → kembali ke revision marker sukses terakhir (revisions table).

### 7.3 Isolasi kegagalan
- Adapter error → try/catch di DeploymentManager; project lain tidak terpengaruh (worker terpisah).
- Deployment terputus (runner mati di tengah): marker success tidak ter-set → saat restore-state, RollbackManager melihat deployment RUNNING > timeout (10 menit) tanpa marker → auto-rollback ke revision sukses terakhir + audit `AUTO_ROLLBACK_DISCONNECTED`.

### 7.4 Deployment record fields
project_id, revision, actor, status, stage, error (sanitized, max 8KB), started_at, finished_at, retry_of, rollback_of + 22 field audit.

---

## 7A. Model Health Check (spesifikasi teknis)

### 7A.1 Tipe check (per service, dipilih di config)
| Tipe | Implementasi | Default timeout/retry |
|---|---|---|
| http | GET/HEAD ke `health_url` → status code + optional body-content match (`expect_status`, `expect_content`) | 5s / 3 retry |
| tcp | net.connect ke host:port, sukses jika connect OK | 3s / 2 retry |
| command | exec `health_cmd` (allow-list pattern) → exit 0 = ok | 15s / 1 retry |
| db | sqlite3 open db path (project-owned) + `SELECT 1` | 5s / 2 retry |
| process | PID existence + port listen check (lsof/ss parsing) | 3s / 1 retry |

- **Multi-check**: array checks — status agregat: semua pass=healthy; ≥1 fail kritis=unhealthy; warning-only (mis. latency) = degraded.
- **Expect body**: `expect_content` regex (dibatasi 256 char, no ReDoS risk — pattern compile check).
- **Health check tidak hanya PID**: kombinasi minimal wajib untuk service TCP: process + tcp. HTTP service: http + process.

### 7A.2 Health status model
health_state.service_id → status ∈ {unknown, starting, healthy, degraded, unhealthy, recovering, failed, stopped, disabled} + consecutive_failures + last_healthy_at.
Setiap check row → health_checks (12 kolom user: project_id, service_id, check_type, timestamp UTC, latency_ms, result, status, error, consecutive_failures, recovery_action).

### 7A.3 Scheduling & storage
- Interval default 30s per service (configurable per project 5-600s), jitter ±10% untuk menghindari thundering herd.
- Worker pool lane khusus health (1 dari 4 worker default) — health check tidak pernah memblok deployment lane.
- Results: tulis ke health.db batch insert (buffer 10) — reduce WAL churn.
- Alert escalation: consecutive_failures ≥ 3 → alert WARNING; ≥5 → CRITICAL + trigger RecoveryManager (jika policy recovery=auto).

---

## 8. Model Recovery State Machine

### 8.1 Internal supervisor loop (per service, interval 5s)
```
tick(service):
  state=READ health_state+supervisor_state
  if crash_loop → skip (manual retry only)
  if disabled/archived/stopped-by-user → skip
  check PID alive?
   ├─ alive & health=unhealthy ≥ threshold → RECOVERING (lihat 8.2)
   ├─ dead & restart_policy=never → FAILED + audit
   ├─ dead & policy=on-failure/always → ambil lock service → cek backoff window
   │    └─ backoff_until < now → STARTING (spawn) → health → record → release lock
   └─ dead & restart_count ≥ max_retries → CRASH_LOOP + audit + notif threshold
  resource over hard-limit → suspend (SIGSTOP) → audit
```

### 8.2 Recovery state machine (per service)
```
HEALTHY ──(health fail × threshold)──► UNHEALTHY_MONITOR
UNHEALTHY_MONITOR ──(consecutive ≥ policy.threshold)──► RECOVERING
RECOVERING: [lock] → check restart policy → backoff wait (5/15/30/60/120)
   → restart → health check → result:
       healthy → HEALTHY (reset counters) + audit + notif "recovered"
       fail   → restart_count++ → backoff next → RECOVERING (loop)
       restart_count ≥ max_retries → CRASH_LOOP:
           - stop auto retry
           - audit CRASH_LOOP_DETECTED
           - health status = failed
           - notifikasi (webhook) "manual retry required"
           - tombol Retry Manual di panel
```

### 8.3 Exponential backoff (persis sesuai spec)
restart 1: 5s; 2: 15s; 3: 30s; 4: 60s; 5: 120s. Window reset: `restart_count` HANYA di-reset jika service stabil (healthy) selama 600s — tidak pernah di-reset oleh restart manager atau migrasi (state supervisor ter-restore, lihat §8.6).

### 8.4 External supervisor (dua layer)
| Layer | Apa yang diawasi | Mekanisme |
|---|---|---|
| Workflow step `supervisor-external` | manager + panel process | loop node script: cek pid file manager & panel; jika mati → spawn ulang (max 3/menit); log ke logs/recovery/ |
| VPS mode | manager + panel + supervisor | systemd unit `vpanel-manager.service` + `Restart=always` + `WatchdogSec` + panel unit; systemd = lapisan paling luar |
- Manager mati total (node crash): workflow step mendeteksi via pid file stale > 10s → restart; jika 3x dalam 1 menit → buat `logs/recovery/manager-crash.report` + continue (runner masih hidup).
- Panel mati: idem, restart panel.
- Kedua layer saling melengkapi: internal (dalam manager) untuk project; external (workflow/systemd) untuk manager+panel.

### 8.5 Notifikasi threshold
- restart_count ≥ 3 → webhook "service degrading"
- CRASH_LOOP → webhook "manual intervention"
- Backup gagal → webhook + audit.

### 8.6 Manager restart / runner restore flow
```
runner baru start → workflow: restore-state (dari backup terakhir valid)
→ integrity check DB → start manager → manager: internal supervisor sweep:
   untuk tiap service enabled: PID file ada? 
     hidup → health check → update state
     mati → restart policy → start
→ start panel → health check panel → audit RESTORE_COMPLETE
```
**Restore journal (intent log) — WAJIB**: crash DI TENGAH restore = kasus first-class (bukan asumsi jarang). Setiap langkah restore menulis tahap terakhir yang SELESAI ke `runtime/temporary/restore-journal.json` SEBELUM eksekusi langkah berikutnya. Start manager berikutnya mendeteksi jurnal → melanjutkan dari tahap setelahnya atau rollback ke pre-restore copy (idempotent, aman di-restart berkali-kali).

**Normalisasi state antar runner**: `service_supervisor_state` (restart_count, backoff_until, crash_loop) IKUT ter-restore — TIDAK di-reset saat migrasi. `backoff_until` berbasis wall-clock lintas host dengan clock berbeda → dinormalisasi saat restore (clamp ke [now, now+120s]). `restart_count` hanya di-reset oleh window stabil 600s, tidak oleh restart manager.

---

## 9. Model Backup & Retention

### 9.1 Alur backup (17 langkah user → implementasi)
```
1.  Ambil global backup lock (locks.db + runtime/locks/backup-global.lock)
2.  Ambil lock per-project yang di-backup
3.  Freeze writer: deployment_queue paused flag + manager pause deployments
4.  Checkpoint semua DB (sqlite backup API per DB)
5.  WAL/SHM stale handling (truncate + checkpoint)
6.  Buat archive temporary (runtime/temporary/backup-<id>/)
7.  Buat manifest.json: version, created_at, project_ids, dbs, files, sizes
8.  SHA-256 seluruh file archive + per-item
9.  Verifikasi archive bisa dibuka (tar -tzf list + extract-test 1 entry)
10. Verifikasi file penting ada (platform.db, projects.db minimal)
11. Verifikasi ukuran masuk akal (> 1KB, < max_backup_size)
12. Verifikasi database integrity (integrity_check pada salinan checkpoint)
13. Upload/simpan ke target storage (local dir / S3 / SFTP)
14. Verifikasi stored: re-download/read-back + checksum
15. Verifikasi checksum hasil download == asli
16. Simpan metadata ke backups.db (18 field user: Backup ID, Project ID, Timestamp UTC, Trigger, File size, SHA-256, DB status, Upload status, Verification status, Retention class, Runner ID, Error)
17. Lepas semua lock
```
**Lock ordering anti-deadlock (aturan global sistem)**: operasi yang butuh >1 lock WAJIB akuisisi berurutan: global lock dulu → project lock diurutkan leksikografis by project ID. Deployment hanya ambil project lock (tanpa global). Backup mem-pause deployment queue, sehingga tidak ada pasangan lock yang diambil dengan urutan berlawanan → deadlock mustahil by construction.
Setiap langkah gagal → status=failed, metadata error disimpan, backup tidak dianggap valid, TIDAK replace backup sehat.
Freeze writer = SATU mekanisme saja: deployment queue di-pause via flag manager (bukan lock kedua yang tumpang-tindih dengan project lock).

### 9.2 Jenis & trigger backup
| Kelas | Trigger | Kapan |
|---|---|---|
| latest | tiap interval (default 6 jam) | runner aktif + sebelum shutdown |
| daily | cron internal manager (04:00 UTC) | runner aktif |
| weekly | Minggu 04:00 | runner aktif |
| manual | user (panel/CLI) | on-demand |
| export | user `vmctl export` | on-demand |
| failed | — | metadata error only |

### 9.3 Retention policy (default, configurable)
| Kelas | Retensi |
|---|---|
| latest | 3 versi |
| daily | 7 versi |
| weekly | 4 versi |
| manual | tidak dihapus otomatis |
| export | tidak dihapus otomatis |
Retention run: hapus backup lama MELEBIHI count yang valid; simpan retention_runs; hanya hapus yang verification_status=valid dan bukan manual/export; urutan hapus = oldest-first; tidak pernah hapus backup valid terakhir jika itu satu-satunya.

### 9.4 Storage monitoring
- platform.db storage_stats: total/used/free/est_full_at (trend regresi dari sampling 1 jam).
- Threshold: free < 20% → WARNING + retention cleanup + stop backup non-prioritas (manual+weekly tetap); free < 10% → CRITICAL + hentikan backup otomatis + webhook alert; manual backup TIDAK dihapus oleh cleanup otomatis.
- Storage target opsional: S3-compatible (lib client), SFTP, atau local `backups/`. Default local (fresh system, dummy creds untuk test).

### 9.5 Jaminan anti-destruktif
- Tidak upload backup gagal/corrupt (verifikasi berlapis langkah 9-15).
- Tidak replace backup valid dengan gagal.
- Rate-limit backup: min interval antar backup otomatis 30 menit (anti "backup baru tiap beberapa detik").
- Backup tidak menyimpan secret plaintext: secrets/vault.enc di-backup HANYA via export --encrypted; backup reguler menyimpan envelope metadata (secret refs) tanpa nilai.

---

## 10. Model Export/Import

### 10.1 Format export
- `export-<scope>-<timestamp>.tar.gz` berisi: manifest.json, projects/, services/, deployments/, health-config/, policies/, audit.db (sanitized), panel-config/, migration-state.json, backup-manifest.json, template-configs.
- Manifest: schema_version, created_at, scope, project_ids, files+sha256, app_version, encrypted flag.
- Default TANPA secret plaintext. `--encrypted` → seluruh payload dienkripsi AES-256-GCM (PBKDF2 600k) + secret vault ikut terenkripsi.

### 10.2 Alur import (15 langkah user)
```
1.  Validasi archive (tar.gz bisa dibuka)
2.  Validasi manifest (schema match, field lengkap)
3.  Validasi checksum (per-file sha256)
4.  Validasi schema (migration runner dry-run)
5.  Validasi project ID (format, bentrok registry → mode merge/replace pilihan)
5b. PRECONDITION: service project terdampak yang RUNNING di-stop dulu; cek konflik port registry dengan service lain yang hidup; cek project ID bentrok dengan service aktif
6.  Tolak path traversal (entries ../, absolute, symlink hardlink)
7.  Tolak file executable/binary tak terduga (whitelist ekstensi)
8.  Buat rollback point (backup pre-import)
9.  Tampilkan ringkasan perubahan (project ditambah/diubah/dihapus)
10. Minta konfirmasi (2 tahap CLI; panel = modal confirm x2)
11. Import atomik: extract ke staging → rename swap per target
12. Integrity check DB hasil
13. Health check services hasil import
14. Catat hasil (audit)
15. Gagal → auto-restore rollback point
```

### 10.3 Export scopes
- `vmctl export project <id>`: registry project + workspace (optional flag) + policies + env refs (bukan nilai).
- `vmctl export all`: seluruh registry + services + deployments meta + health-config + policies + panel config + manager config + audit (sanitized) + migration state.

---

## 11. Permission Model

### 11.1 Roles
| Role | Izin |
|---|---|
| owner | semua operasi: create/delete project, ubah permission, kelola secret ref, restore, rollback, kelola user, purge audit |
| operator | lihat project, deploy, start/stop/restart, lihat log, lihat health, backup manual, TIDAK lihat secret, TIDAK ubah permission |
| viewer | lihat dashboard/status/health/log yang diizinkan, TIDAK aksi |

### 11.2 Matriks izin (action-level)
```
project.create        owner
project.delete        owner
project.view          viewer+operator+owner (scoped)
project.deploy        operator+owner
service.start         operator+owner
service.stop          operator+owner
service.restart       operator+owner
service.logs.view     viewer+operator+owner (scoped)
service.health.view   viewer+operator+owner
backup.create         operator+owner
backup.restore        owner
deployment.rollback   owner
secret.view           owner (nilainya pun TIDAK pernah ditampilkan; hanya metadata ref)
permission.manage     owner
user.manage           owner
audit.view            operator+owner (viewer: no)
audit.purge           owner (2-konfirmasi)
export/import         owner
panel.settings        owner
```

### 11.3 Scoping
- Per user, per role, per project, per service, per action: table `project_scopes` (users.db) — jika ada row scope untuk user maka hanya scope itu yang terlihat; tanpa scope = semua project sesuai role.
- Enforcement point: manager API middleware (setiap request) + panel UI gating + vmctl token role.
- Cache permission 60s (invalidasi saat permission.change).

### 11.4 Actor & authentikasi
- Actor = user panel / vmctl token / system (workflow). vmctl memakai token file runtime/sockets/cli-token (generated oleh manager, mode 600) — role di-embed.
- Panel auth: lihat §16 (password scrypt OWASP params + TOTP + recovery codes; session HttpOnly+SameSite+CSRF; lockout 5 gagal/15 menit; rate limit).
- Admin approval flow: user baru dibuat status=inactive; owner approve → active. (default invite flow; konfirmasi lihat §22).

---

## 12. Threat Model

### 12.1 Format: STRIDE per komponen
| # | Ancaman | Komponen | Vektor | Mitigasi (implementasi nyata) |
|---|---|---|---|---|
| 1 | Spoofing | Panel login | Brute force password/TOTP | scrypt (N=2^17, r=8, p=1, maxmem 256MB — OWASP) + lockout 5/15m + rate-limit per IP + audit fail |
| 2 | Spoofing | Session | Cookie theft | HttpOnly+Secure+SameSite=Strict, expiry 8 jam, rotate di re-auth |
| 3 | Spoofing | Manager API | Token abuse di loopback | Bearer token + rate-limit; anti-replay nonce DIPANGKAS (loopback-only, HTTPS tak berlaku di loopback — risiko rendah) |
| 4 | Tampering | Project config | Edit registry manual | Validasi schema + referential check saat load (HMAC signing registry DIPANGKAS — ancamannya local attacker yang sudah pegang box) |
| 5 | Tampering | Backup archive | Corrupt/tamper | SHA-256 manifest + verify read-back + integrity_check |
| 6 | Tampering | Audit log | Edit history | SQLite trigger append-only + owner purge 2-confirm (yang membuat event baru) |
| 7 | Repudiation | Semua aksi | Bisa disangkal actor | Audit event actor+user+role+IP+before/after untuk setiap operasi |
| 8 | Info disclosure | Log | Secret leakage | Redaction pipeline: regex token/password/api-key/cookie/private-key/session/OTP + secret-store pattern match (nilai aktif dicari di string) |
| 9 | Info disclosure | Export default | Secret terbawa | Manifest filter; secret hanya --encrypted; redacted audit |
| 10 | Info disclosure | Panel API | Secret di response | API TIDAK pernah return nilai secret; hanya ref metadata |
| 11 | DoS | Manager API | Flood | Rate limit per token/IP + queue cap 32 |
| 12 | DoS | Disk | Backup flood | Retention + rate-limit + storage monitor + cap ukuran |
| 13 | DoS | Project resource | CPU/RAM runaway | Resource limits (systemd-run/Job Object) + hard-limit suspend |
| 14 | Elevation | Permission bypass | viewer→operator | Middleware enforce per action + scope + audit denied |
| 15 | Elevation | Project→system | Project akses folder lain | Workspace isolation + path validation ( realpath prefix check) + no-global-env |
| 16 | Elevation | Project→manager | Project kill manager | PID files mode 600 owner-manager; project tidak punya akses |
| 17 | Injection | Command | Malicious start_cmd | Command allow-list (pattern allow), no-shell exec (argv array) |
| 18 | Injection | Git repo | Malicious repo (post-install script) | npm ci --ignore-scripts default; flag allow-scripts per project; repo URL whitelist domain |
| 19 | Injection | Docker image | Untrusted image | Image allow-list; compose config audit; digest pin di VPS mode (di GHA: docker adapter verify-mode saja — runner GHA tanpa docker pre-installed penuh untuk compose berat) |
| 20 | Injection | Archive import | Zip/traversal | Entry validation: no ../, no absolute, no symlink, whitelist ext |
| 21 | Injection | Symlink | Workspace escape | Workspace scan symlink → reject saat deploy; realpath check semua write |
| 22 | DoS | Port | Port collision/hijack | Bind-test + registry + EADDRINUSE retry |
| 23 | Availability | Crash-loop | Service mati-mati | Restart limit + backoff + crash-loop state + manual retry |
| 24 | Availability | DB corrupt | WAL stale/kosong | §5.5 recovery pipeline + refuse-start on empty/non-SQLite |
| 25 | Availability | Storage penuh | Backup gagal | §9.4 monitor + retention + prioritas |
| 26 | Availability | Runner death | Job timeout | Self-chain + final backup + restore-state (§15) |
| 27 | Spoofing | CSRF | Panel action via form jahat | Double-submit cookie + SameSite=Strict + referer check |
| 28 | Spoofing | Replay API | Reuse request | Digabung ke #3 (dipangkas; loopback + bearer cukup untuk fase ini) |
| 29 | Availability | Duplicate deploy | Deploy ganda | Project lock → DEPLOY_IN_PROGRESS rejection |
| 30 | Availability | Concurrent backup | Backup ganda | Global backup lock → BACKUP_IN_PROGRESS |
| 31 | Supply-chain | Workflow sendiri | fork PR + secrets exposure, workflow tampering | `permissions:` minimal per job; secrets TIDAK dipass ke fork PR; workflow file di-protect branch protection |
| 32 | Info disclosure | Vault key vs CI env | VPANEL_MASTER_KEY & GITHUB_TOKEN di env yang sama | Master key dipakai HANYA oleh proses manager (tidak pernah diekspor ke step lain); redaction mencakup nilai key di log workflow |

### 12.2 Trust boundaries
```
Untrusted: project code, git repo, archive import, panel input, webhook target
Semi-trusted: vmctl operator (token), panel session user
Trusted: manager core, secret store, audit, backup store (setelah verify)
Boundaries: (a) internet→panel auth; (b) panel→manager API (localhost);
(c) manager→project process (spawn, no reverse channel); (d) manager→backup storage (verify read-back)
```
**Pernyataan jujur tentang boundary (c)**: di GitHub Actions runner, project process berjalan sebagai user OS yang SAMA dengan manager → isolasi project bersifat ADVISORY (process bisa membaca file manager jika code-nya berusaha keras; tidak ada user separation). Mitigasi pragmatis fase ini: env whitelist, path check, no-shell argv, resource limits. Boundary (c) menjadi boundary ASLI hanya di VPS mode: service systemd user terpisah per project + file permission 750. Ini dicatat eksplisit di §21 keterbatasan.

### 12.3 Cryptography
- Password: `crypto.scrypt` bawaan Node (N=2^17, r=8, p=1, maxmem 256MB, 64-byte key — parameter minimum OWASP; scrypt adalah rekomendasi #2 OWASP setelah Argon2id, memadai menggantikan bcrypt TANPA native dependency).
- TOTP RFC-6238 via `crypto.createHmac('sha1')` (standar, kompatibel semua authenticator; base32 decoder kecil ditulis sendiri + `timingSafeEqual`).
- AES-256-GCM secret store + export; PBKDF2-SHA256 600k iter export password; SHA-256 checksum.
- KDF pepper + master key dari env `VPANEL_MASTER_KEY` (di runner: GitHub Actions secret; VPS: file mode 600) → key hierarchy per purpose (K_enc untuk vault, K_export untuk encrypted export).

---

## 13. Rencana Secret Management

### 13.1 Arsitektur secret
```
config.yaml          → konfigurasi biasa (no secret)
projects/*.yaml      → metadata project (no secret, hanya secret_ref)
.env                 → VPANEL_MASTER_KEY reference (bukan nilai), port, env flags
secrets/vault.enc    → AES-256-GCM envelope: {name, project_scope, ciphertext, iv, tag, created, rotated_at, expires_at}
secrets/secrets.yaml → hanya referensi {name → project_scope} (metadata, no values)
runtime env injection→ saat spawn: SecretManager resolve refs → child env
```

### 13.2 Aturan implementasi
- Master key TIDAK pernah di-commit; dari env/GHA secret/VPS keyfile. Rotasi: re-encrypt vault.
- Per-project scope: secret hanya bisa di-resolve oleh service dari project yang sama (scope check di SecretManager).
- Redaction: pipeline wajib sebelum tulis log/audit/error: pattern (token|password|api[_-]?key|private[_-]?key|session|otp|cookie|authorization|bearer) + active-secret-value matching (nilai secret aktif di-scan dalam string → ganti `***REDACTED***`).
- Panel/API TIDAK pernah return nilai secret (bahkan owner) — hanya metadata (name, scope, rotated_at, expires_at).
- Rotation hook: `vmctl secret rotate <name>` → re-encrypt + update refs; expiry check tiap startup → alert.
- GitHub Actions: secret via environment secrets → env → vault init; least-privilege (hanya secret yang dibutuhkan job).
- Log redaction test wajib (test #29-30).

### 13.3 Dummy untuk testing
- Dummy token `dummy-token-<random>`; dummy vault init key `test-master-key-do-not-use`; TOTP test vector RFC 6238; semua di test fixtures, tidak pernah secret nyata.

---

## 14. Rencana Audit Logging

### 14.1 Event yang dicatat (semua operasi penting)
- Lifecycle: create/install/prepare/configure/start/stop/restart/archive/restore/remove/enable/disable
- Deployment: deploy start/stage/success/fail/retry/rollback + auto-rollback
- Health: status transitions (unhealthy→recovering dst.), alert raise/clear
- Recovery: restart attempt, backoff applied, crash-loop detected, manual retry
- Backup: create start/verify/upload/fail, retention run delete
- Restore/export/import: start/verify/confirm/success/fail/rollback-point
- Auth: login success/fail, lockout, logout, session expired, 2FA change
- Permission: grant/revoke/scope change
- System: startup, shutdown, runner restore, self-chain, migration, integrity check result
- Database: corrupt detected, salvage, quarantine, restore

### 14.2 Struktur event (22 field user + standar)
at (UTC ISO8601), actor, user_id, role, project_id, service_id, operation, input (sanitized JSON), status_before, status_after, revision_before, revision_after, pid_old, pid_new, port, backup_id, deployment_id, runner_id, recovery_action, error, result + ip (panel).

### 14.3 Append-only + purge
- SQLite trigger `no_delete` + `no_update` (hanya INSERT permission untuk role manager).
- Purge (owner only): 2-konfirmasi + wajib reason + membuat event `AUDIT_PURGE` baru berisi range yang dihapus (metadata tetap ada — jejak purge tidak hilang).
- Redaction sama dengan §13.2 (input_json disanitasi sebelum insert).

### 14.4 Retensi audit
- Default: keep forever (append-only). Opsi archive ke backup kelas manual (per tahun) — configurable, default off.

---

## 15. Rencana Self-Chain

### 15.1 Mekanisme
- Runner GitHub Actions ephemeral: job max 6 jam / 360 menit (terverifikasi) dari **waktu mulai job yang dilaporkan GitHub**, bukan jam runner. Sisa waktu dihitung dari `started_at` job via API, bukan `Date.now()` lokal (anti clock-skew & job-start offset); drain window diklamp minimal 10 menit.
- Sistem self-chain: sebelum timeout, workflow dispatch job baru (runner berikutnya) via `workflow_dispatch` + GITHUB_TOKEN — terverifikasi: `workflow_dispatch` & `repository_dispatch` adalah **pengecualian eksplisit** dari aturan "event GITHUB_TOKEN tidak memicu run baru"; permission wajib `permissions: actions: write` (contents:write TIDAK diperlukan untuk dispatch); rate limit GITHUB_TOKEN 1000 req/jam/repo (cukup).
- Guard rail anti split-brain: `runner.lock` berisi `{run_id, expires_at, chain_epoch}` — twin workflow (recovery.yml) HANYA boleh dispatch jika SEMUA terpenuhi: (a) `now > expires_at`, (b) cek API "run in progress vm.yml" negatif (bukan hanya trust lockfile), (c) ambang stale 30 menit (> interval cron, mencegah race twin-vs-chain asli saat runner delay). Setelah dispatch sukses, chain asli yang mengambil alih lock via run_id baru.
- `concurrency: group: vm-chain` di vm.yml → dispatch ganda mengantri, tidak paralel (defense in depth anti dua runner restore bersamaan).
- Chain epoch: setiap generasi chain menaikkan epoch; `chain_depth` DIBATASI (default 100) + runner_state di-rotasi per epoch — mencegah state lintas-runner yang tak berbatas.
- Keepalive: ping `runner_state.watchdog_seen` tiap 60s oleh manager; jika manager mati > 10 menit → workflow step restart manager (max 3), lalu continue chain.

### 15.2 Urutan shutdown (sebelum waktu habis)
```
t-15m: tandai runner draining (runner_state.phase) → tolak deployment baru
t-12m: selesaikan/batalkan job aman (deployment_queue drain)
t-10m: checkpoint semua DB + WAL truncate
t-08m: final backup (kelas latest) + verify
t-06m: dispatch runner berikutnya (workflow_dispatch + GITHUB_TOKEN)
t-05m: tunggu runner baru terdeteksi (cek run started)
t-03m: graceful stop services (SIGTERM all)
t-01m: stop panel, stop manager, write shutdown marker
t-00: job end
```
(Runner baru: restore-state dari backup → integrity check → start manager → start enabled → health → phase=active.)
**Uji cancel di SETIAP titik**: recovery.yml adalah net yang diuji eksplisit untuk cancel di t-15m, t-12m, t-10m, t-08m, t-06m, t-03m, t-01m (bukan hanya graceful path) — skenario 20-22 di §19.

### 15.3 Jika self-chain gagal
- Watchdog eksternal = recovery.yml (cron tiap 15 menit): cek via API apakah ada run aktif vm.yml ATAU lock masih hidup (belum expired + run_id masih in-progress); jika keduanya negatif → dispatch vm.yml baru (state dari backup valid terakhir).
- Jika dispatch gagal (API limit): retry 3x backoff 60s; jika tetap gagal → buat issue otomatis (label runner-down) sebagai alert manusia.
- Sistem TIDAK menganggap migration sukses tanpa health check post-restore (gate di workflow: `verify-health` step wajib lulus sebelum phase=active).

### 15.4 Kapan self-chain tidak dipakai
- VPS mode: systemd handle uptime; self-chain hanya untuk mode GitHub Actions. Config `host.mode: actions|vps|container`.

---

## 16. Rencana Runner Migration

### 16.1 Apa yang di-migrate
State: 9 DB (backup API), registries, runtime environments, secret vault (encrypted), configs, logs opsional. BUKAN: PID/processes (tidak relevan lintas host), sockets.

### 16.2 Alur migrasi (runner→runner & runner→VPS sama)
```
1.  Host A: marking draining → stop deployment baru
2.  Host A: final backup + verify
3.  Host A: export ke artifact/backup-storage (S3/SFTP/local mounted)
4.  Host B (runner baru / VPS): bootstrap (fresh check)
5.  Host B: restore-state (dengan restore journal — lihat §8.6; crash di tengah restore aman: resume/rollback idempotent) → integrity check → migration runner
6.  Host B: start manager → supervisor sweep (start enabled services; supervisor state ter-restore, backoff dinormalisasi)
7.  Host B: health check all
8.  Catat migration event (runner_id A→B, chain_epoch, duration, result)
9.  Jika gagal: Host B auto-restore ke rollback point / Host A state tetap valid di storage
```

### 16.3 GitHub Actions specifics
- Backup diekstrak dari storage eksternal (bukan repo Git — repo hanya kode, bukan state).
- Artifact antar-job dipakai untuk chain cepat; artifact retention default 90 hari (terverifikasi, configurable 1-400 hari private repo); storage eksternal untuk jangka panjang.
- GITHUB_TOKEN cukup untuk self-dispatch via workflow_dispatch (pengecualian eksplisit dari aturan non-triggering; terverifikasi) — permission `actions: write`, tanpa PAT.
- Runner ID dicatat (runner_state) untuk audit chain.

---

## 17. Rencana Migrasi ke VPS Nyata

### 17.1 Abstraction layer
- `lib/platform` menyediakan: process spawn/kill, resource limiting (systemd-run/cgroup), PID tools, storage mount — implementasi per host-mode (actions/vps/container).
- Config `host.mode` menentukan backend; tidak ada kode spesifik host di manager core.

### 17.2 Target Ubuntu VPS
- Systemd units: vpanel-manager.service, vpanel-panel.service, vpanel-supervisor.service (Restart=always, WatchdogSec=300, sandbox directive: ProtectSystem, PrivateTmp, NoNewPrivileges).
- Reverse proxy: Caddy/Nginx (TLS otomatis) → panel domain + project subdomains; firewall: hanya 80/443 + SSH.
- Storage backup: rclone/S3/SFTP ter-mount atau cron sync; retention tetap dikelola BackupManager.
- Domain sendiri + TLS via reverse proxy; project exposure via reverse-proxy map (subdomain per project).
- Script `scripts/migrate-to-vps.sh`: setup dependency + restore backup + systemd enable + health verify.

### 17.3 Docker/container target
- Image node:20-slim; volume untuk data/, backups/, secrets/, logs/; manager + panel + supervisor via supervisor inside container atau systemd-mode compose; port map via host.
- Kubernetes (opsional lanjutan): Deployment untuk manager+panel, PVC untuk state, CronJob backup — dokumentasi saja di fase ini (lihat §22 keputusan).

### 17.4 Checklist migrasi (dokumen tersendiri di docs/)
pre-migration (backup verify, storage target siap, DNS), migration (stop source, final backup, restore, health), post (monitor 24 jam, old host decommission, audit MIGRATION_COMPLETE).

---

## 18. Rencana Testing

### 18.1 Struktur test suite
```
tests/
├── unit/           → lib: db tx/migrate, lock, redaction, crypto, path validation,
│                     port allocation, backoff calc, permission matrix, adapter schema
├── integration/   → manager E2E: create→deploy→start→health→stop→archive→restore;
│                     backup full pipeline; export/import; concurrent ops; supervisor
├── security/      → traversal/injection/CSRF/authz/rate-limit/redaction/archive-attack
├── recovery/      → failure simulations (crash-loop, corrupt DB, WAL stale, manager death)
└── fixtures/      → dummy repos, dummy tokens, dummy vault, sample configs
```

### 18.2 Pemetaan 75 test wajib user → suite
- #1-13 (install/bootstrap/static/node/python/concurrent/port): integration/install.test.js
- #13-17 (port conflict/illegal/dup name/repo invalid/branch invalid): integration/validation.test.js
- #18-21 (traversal/cmd injection/symlink/unauth): security/path-injection.test.js
- #21-30 (auth: wrong pw/OTP/session/CSRF/permission ×3/secret redaction ×2): security/auth.test.js + security/permission.test.js
- #31-43 (backup/checksum/corrupt archive/db corrupt/WAL/SHM/restore/rollback/export/encrypted export/import/checksum import/traversal import): integration/backup-restore.test.js + recovery/db.test.js
- #44-48 (deployment fail/retry/service dead/auto-restart/crash-loop/restart limit): recovery/supervisor.test.js
- #50-57 (health timeout/manager death/external supervisor/panel death/runner timeout/self-chain/restore runner/project fail isolation): recovery/system.test.js
- #58-63 (docker/mc-java/mc-bedrock/hermes/router/rollback disconnected): integration/adapters.test.js (mc: verify-command mode, dummy binary)
- #64-68 (dua deployment/dua backup/storage hampir penuh/retention/export-import all): integration/concurrency.test.js
- #69-75 (unit tests/integration/security/lint/type check/syntax/no-internet): CI pipeline (§18.4)

### 18.3 Metodologi
- Test runner: Node built-in `node:test` (no dep) + custom harness untuk E2E spawn.
- Semua test memakai sandbox directory tmp (fresh per run) + dummy data — never touching real system data.
- Failure simulation: kill -9 process, corrupt file byte-flip, truncate WAL, fill disk (quota), stale lock, port squat (bind manual), replay token, dsb.
- Health check timeout test: dummy slow server (setTimeout hang).
- No-internet test: spawn manager dengan env no-proxy + dummy local git (file:// repo) + local registry mirror (dummy npm via verdaccio optional skip — fallback: pre-installed node_modules fixtures).

### 18.4 CI pipeline (GitHub Actions di repo ini)
```
jobs: lint (eslint) → type (tsc --noEmit dengan checkJs + JSDoc — codebase JS murni) → unit → integration → security → recovery
(paralel via matrix; setelah merge main: nightly full + backup verify)
```

### 18.5 Definition of Done (per fase implementasi)
- Semua test suite hijau; coverage target: core module ≥ 85% (manager lib), adapter ≥ 70%.
- 75 kategori test user dieksekusi nyata (bukan dokumentasi) — checklist hasil ditulis ke `docs/test-report.md`.
- Lint + typecheck + syntax check bersih; npm audit tanpa critical.

---

## 19. Rencana Failure Simulation

### 19.1 Simulasi wajib (24 skenario utama → 75+ sub-test)
| # | Skenario | Cara simulasi | Expected outcome terverifikasi |
|---|---|---|---|
| 1 | Service mati tiba-tiba | kill -9 PID | supervisor detect < 5s → restart sesuai policy → audit → healthy |
| 2 | Crash-loop | project exit 1 loop | backoff 5/15/30/60/120 → crash-loop state → manual retry button → audit |
| 3 | Restart limit | exit 1 > 5 kali | auto-retry stop; status CRASH_LOOP; tidak restart tanpa batas |
| 4 | Health timeout | dummy hang server | timeout + retry → consecutive fail → recovery |
| 5 | Manager mati | kill manager process | external supervisor restart < 15s; state utuh |
| 6 | Panel mati | kill panel | external supervisor restart; session valid tetap; audit |
| 7 | Runner timeout (graceful) | job GHA diberhentikan (simulasi cancel di t-01m) | self-chain dispatch → runner baru restore → health gate |
| 8 | DB corrupt | byte-flip platform.db | refuse-start; recovery pipeline; salvage; atomic swap; audit; data valid terakhir dipertahankan |
| 9 | WAL/SHM stale | copy -wal dari run lain | detect stale → checkpoint + purge → start OK |
| 10 | DB kosong/invalid header | truncate ke 0 / text file | refuse-start + instruksi manual (no auto-delete) |
| 11 | Backup corrupt | flip byte archive | verify gagal → status failed → tidak replace valid → metadata error |
| 12 | Storage hampir penuh | quota dir kecil | stop backup non-prioritas + retention cleanup + alert + manual tetap |
| 13 | Dua deployment bersamaan | dua CLI paralel | satu jalan, satu ditolak DEPLOY_IN_PROGRESS |
| 14 | Dua backup bersamaan | dua CLI paralel | global lock → BACKUP_IN_PROGRESS rejection |
| 15 | Project gagal saat lain jalan | deploy A sengaja gagal | B tetap running; A failed + retry tersedia |
| 16 | Import checksum salah | edit archive | reject + rollback point tetap |
| 17 | Import path traversal | tar entry `../../etc` | reject entry + audit |
| 18 | Rollback deployment terputus | kill saat deploy | marker unset → auto-rollback ke revision sukses |
| 19 | Manager mati DI TENGAH restore | kill manager di tiap tahap restore (fault injection per tahap) | restore journal → resume/rollback idempotent; TIDAK brick |
| 20 | Manager mati DI TENGAH recovery/crash-loop | kill saat backoff/restart in-progress | lock lepas saat process mati; state konsisten; sweep lanjut benar |
| 21 | Backup vs deployment konkuren | deploy + backup bersamaan | queue pause → tidak deadlock; salah satu antre benar |
| 22 | Cancel GHA di tiap titik timeline | cancel job di t-15m/12m/10m/08m/06m/03m/01m | recovery.yml net: runner baru naik + restore + health gate; tidak split-brain |
| 23 | Double-chain split-brain | twin dispatch dipaksa saat chain asli delay | hanya satu run lanjut (concurrency group + expiry + run-in-progress check) |
| 24 | Port leak & akumulasi | child gagal bind; squat port; hapus service | registry konsisten dengan `ss`; rekonsiliasi bersihkan yatim; audit |

### 19.2 Verification requirements per simulasi
Setiap simulasi wajib membuktikan: (1) deteksi tercatat, (2) event di-audit, (3) recovery dijalankan, (4) retry dibatasi, (5) status akhir jelas, (6) data valid terakhir tetap ada, (7) tidak ada data valid terhapus, (8) prosedur manual tersedia (docs), (9) hasil recovery diverifikasi (health check post).

### 19.3 Harness simulasi
`tests/recovery/simulate.js` — script yang menjalankan 24 skenario di atas secara otomatis + assertion + laporan `docs/test-report.md` (bisa dijalankan lokal & CI). Skenario 7/22 versi CI memakai mock dispatch API; versi NYATA (dispatch Actions sungguhan) dijalankan sebagai **live chain drill mingguan** via workflow terpisah (`chain-drill.yml`, timeout pendek + dispatch manual) dan hasilnya dilaporkan di test-report — klaim "self-chain bekerja" hanya sah dengan drill nyata ini.

---

## 20. Risiko Penggunaan GitHub Actions

| # | Risiko | Dampak | Mitigasi dalam desain |
|---|---|---|---|
| 1 | Runner ephemeral (6 jam) | Uptime putus | Self-chain + final backup + restore-state gate health |
| 2 | Job dapat dibatalkan kapan saja | State setengah jalan | Atomic ops + marker + auto-rollback disconnected |
| 3 | IP berubah | Whitelist eksternal putus | Semua outbound via config; tidak ada binding IP di state |
| 4 | Tunnel gratis berubah URL | Project publik putus | Tunnel opsional; reverse-proxy domain sendiri di VPS mode |
| 5 | Storage lokal tidak permanen | Kehilangan state | Backup eksternal S3/SFTP wajib untuk state penting |
| 6 | Game server berat tidak stabil | MC lag/crash | Resource limits + verify-command mode untuk mc test; VPS untuk produksi MC |
| 7 | Website produksi tidak ideal | Latency/SLA | Dokumen batasan; VPS migration path |
| 8 | DB produksi di runner tidak ideal | Data risk | Backup eksternal + restore pipeline; rekomendasi VPS untuk DB produksi |
| 9 | Uptime tidak dijamin seperti VPS | SLA | Dokumen eksplisit; self-chain meminimalkan gap |
| 10 | Self-chain bisa gagal (API limit, dsb) | Downtime | recovery.yml watchdog + issue alert + final state valid |
| 11 | Rate limit GHA API | Chain dispatch gagal | Retry + backoff + twin workflow safeguard |
| 12 | 2FA/GITHUB_TOKEN scope | Dispatch gagal | GITHUB_TOKEN cukup untuk self-dispatch (workflow_dispatch = pengecualian eksplisit; `actions: write`); tidak perlu PAT |
| 13 | Repo abuse ToS | Akun/GitHub ban | Beban berat (game server, produksi) dilarang di runner GHA — didesain verify-mode; produksi penuh diarahkan ke VPS |

### 20.1 Pernyataan eksplisit (akan ditulis di README)
Runner GitHub Actions BUKAN VPS. Runner sementara, bisa berhenti kapan saja, job ada batas waktu, IP berubah, storage tidak permanen, game server berat & website produksi & DB produksi tidak ideal, uptime tidak terjamin. Self-chain mengurangi gap tapi tetap bisa gagal; backup eksternal WAJIB untuk state penting; VPS nyata lebih cocok untuk service produksi. Panel VM ini memang dirancang untuk migrasi mulus ke VPS.

---

## 21. Keterbatasan Sistem (saat fase ini)

1. Single-host: semua project di satu host (runner/VPS). Multi-host/fleet = fase berikutnya (lihat §1.3).
2. GitHub Actions runner: uptime gap antar chain (±1-3 menit per migrasi), IP berubah, tidak cocok game berat/produksi.
3. Resource limit di GitHub runner: ~2 vCPU/7GB RAM shared — mc-java realistis hanya sedikit player; mc-bedrock verify-only.
4. Windows host resource limiting = fallback advisory (audit WARNING) — full enforcement di Linux/VPS.
5. SQLite: cocok untuk skala ini; bukan Postgres-cluster — DB produksi besar sebaiknya tetap di service terkelola.
6. Panel SSR tanpa framework: cepat & tanpa CDN, tapi interaktivitas kaya (grafik realtime dsb.) sengaja minimal (ops info).
7. Real-world adapters (telegram/whatsapp/discord/hermes/router) diuji dengan dummy credentials/verify-mode: tidak ada akun/production bot nyata di fase ini.
8. Notifikasi = webhook generik (bukan integrasi bot pribadi — menjaga independence panel).
9. Kubernetes target: hanya dokumentasi arsitektur; implementasi = fase lanjutan.
10. Multi-user panel: mendukung banyak user, tapi default deployment = single-owner (kecil).
11. i18n UI: English default; i18n = nice-to-have fase lanjutan.
12. Hanya IPv4 listening default; IPv6 opsional config.
13. Log retention otomatis belum (rotation manual / backup class manual) — fase lanjutan.
14. Time-series resource sampling: ring-buffer 7 hari (health.db) — bukan Prometheus; observability lanjutan fase berikutnya.
15. **Isolasi project di runner GHA = advisory** (project process berjalan sebagai user OS yang sama dengan manager — lihat §12.2): project code jahat secara teori bisa membaca file manager. Boundary asli hanya di VPS mode (systemd user terpisah per project). Jangan jalankan project tidak terpercaya di mode GHA.
16. Self-chain tetap bisa gagal (API rate limit, GitHub incident, akun dibatasi) — watchgod recovery.yml memitigasi tapi tidak menjamin; alert manual via issue otomatis.
17. Node 20: coverage `node:test` masih experimental (`--experimental-test-coverage`) — coverage diukur di Node 22/24 CI job.

---

## 22. Daftar Keputusan yang Butuh Persetujuan

**D1. Nama & branding**
- D1a: Nama folder sistem = `VM-Panel` (folder kerja ini, keputusan user) + binary `vmctl` + internal brand "VPANEL" untuk log prefix. Nama paket npm: `vm-panel` (lowercase).
- D1b: Nama file workflow utama: `vm.yml` (sesuai struktur user). Alternatif `vpanel.yml` — mana yang dipakai? (struktur user menyebut vm.yml; backup.yml & recovery.yml tetap).

**D2. Runtime & dependency**
- D2a: Node.js ≥ 20, core zero-dependency + SATU dep ter-pin `better-sqlite3` (node:sqlite bawaan belum stabil; terverifikasi riset). Setuju? Atau Python core / Go core?
- D2b: npm sebagai PM (pinned lockfile commit, `npm ci` di CI, dep opsional exact-pin). OK?

**D3. Database**
- D3a: 9 SQLite DB + WAL + single-writer manager. OK? (alternatif: 1 DB + table-prefix, atau DuckDB)
- D3b: Audit append-only via SQLite trigger + purge owner 2-konfirmasi yang meninggalkan event jejak. OK?

**D4. Adapters & templates**
- D4a: Adapter docker-compose memakai `docker compose` v2 (bukan docker-compose v1 python). OK?
- D4b: Minecraft Java real-run di runner GHA: hanya verify-command (server boots + eula + stop) dengan RAM limit kecil — full 24/7 MC direkomendasikan di VPS. OK?
- D4c: MC Bedrock di GHA: verify-only (binary terunduh+start 10 detik+stop) karena EULA & resource. OK?
- D4d: Bot adapters (telegram/whatsapp/discord): dummy token + verify-mode (connect-check dry). Hermes/9Router: template project dummy. OK?

**D5. Panel & auth**
- D5a: Panel SSR vanilla (no framework, no CDN) hitam profesional sesuai spec UI. OK?
- D5b: Auth = password (scrypt OWASP) + TOTP wajib + recovery codes + lockout 5/15m. Session cookie HttpOnly SameSite=Strict + CSRF double-submit. OK? (alternatif: passkey/WebAuthn ditunda)
- D5c: Admin approval flow untuk user baru (default ON) vs open-registration (OFF default). OK ON?

**D6. Manager API**
- D6a: Manager listen 127.0.0.1:8097 bearer token; panel & vmctl via loopback. OK?
- D6b: vmctl fast-path status/log baca DB read-only langsung saat manager down. OK?

**D7. Resource limiting**
- D7a: POSIX systemd-run/cgroup; Windows fallback advisory. OK?
- D7b: Hard-limit policy: suspend+stop service saat 2× soft selama 3 sampel. OK?

**D8. Self-chain**
- D8a: Chain via `workflow_dispatch` + GITHUB_TOKEN (`actions: write`, terverifikasi) + `concurrency group vm-chain` + runner.lock berisi `{run_id, expires_at, chain_epoch}` + twin recovery.yml watchdog dengan cek API run-in-progress + ambang stale 30 menit + chain_depth max 100 dengan rotasi epoch. OK? (alternatif: schedule cron 10m saja, lebih sederhana tapi gap lebih besar dan split-brain lebih mungkin)
- D8b: Threshold timing shutdown: sisa waktu dihitung dari `started_at` job via API (bukan jam runner), mulai draining t-15 menit sebelum timeout 360 menit, drain window clamp min 10 menit. OK?
- D8c: Live chain drill mingguan (workflow `chain-drill.yml`) sebagai bukti nyata self-chain — hasil masuk test-report. OK?

**D9. Storage backup default**
- D9a: Default local `backups/` + SFTP/S3 opsional via config (dummy creds untuk test). OK?
- D9b: Retensi default: latest=3, daily=7, weekly=4, manual/export never. OK?

**D10. Export/secret**
- D10a: AES-256-GCM + PBKDF2 600k untuk export --encrypted & vault. OK?
- D10b: Secret tidak pernah ditampilkan di panel/API (bahkan owner) — hanya metadata. OK?

**D11. Testing scope**
- D11a: Test runner node:test + CI lint/typecheck/unit/integration/security/recovery paralel. OK?
- D11b: MC real-run hanya verify-mode di GHA; full test di VPS. OK?
- D11c: Coverage target: core ≥ 85%, adapter ≥ 70%. OK?

**D12. Timeline & fase implementasi**
- F1: core lib (db/lock/crypto/platform) + manager skeleton + audit + permission + CLI basic (2-3 hari kerja)
- F2: adapters static/node/python + health + supervisor internal (2 hari)
- F3: backup/restore/rollback/export/import (2 hari)
- F4: panel UI + auth + permissions UI (2-3 hari)
- F5: workflows GHA + self-chain + simulate harness + docs final (2 hari)
- Setuju urutan ini? (paralelisasi mungkin: F4 setelah F2 bisa jalan paralel dengan F3)

---

## Lampiran A: Konstanta sistem
- ID format: `prj_`, `svc_`, `dep_`, `bak_` + 10 char base32 (Crockford)
- Timestamp: UTC ISO-8601 everywhere
- Port range alloc: 10000-65535 (configurable), reserved < 10240
- Max backup size: 2 GB default (configurable)
- Session TTL: 8 jam; TOTP window ±1
- Backoff seq: [5,15,30,60,120]s; window reset 600s
- Health interval: 30s default
- Worker pool: 4 (1 health lane, 3 deploy lane)
- Queue cap: 32
- Rate limit: 60 req/menit per token; login 10/menit/IP
- Storage threshold: warn 20%, critical 10%

## Lampiran B: UI mockup (deskriptif)
Dashboard (dark #0a0a0a): top bar "VPANEL — VM-Panel" + user menu; kiri: nav sidebar (Dashboard, Projects, Services, Deployments, Ports, Logs, Backups, Health, Recovery, Audit, Users, Permissions, Settings); main: cards grid: system status (VM uptime, manager uptime, panel uptime), resource bars (CPU/Mem/Disk % monospace), runner status (phase, expires countdown, chain depth), port registry mini-table, recent alerts list; status dots: healthy=green, degraded=amber, unhealthy/crash=red, stopped=gray, disabled=gray-outline, unknown=dashed-circle.
Project detail: header (name, id mono, type badge, status dot) + tabs: Overview (metadata grid mono), Deployments (table), Health (sparkline + checks), Logs (tail viewer, mono), Settings (restart policy editor, health-check editor, port, env refs, secret refs metadata-only).
Login: centered card, dark, password + TOTP field, error state jelas, no CDN.
