# ARCHITECTURE.md — Ringkasan Arsitektur

Ringkasan desain DESIGN.md §1-4. Sumber kebenaran tetap [`DESIGN.md`](DESIGN.md) — dokumen ini hanya peta ringkas untuk orientasi cepat.

## 1. Apa yang dibangun

VM-Panel = control plane + runtime plane untuk mengelola banyak project di satu host. Tiga konstituen:

| Komponen | Peran |
|---|---|
| **Manager** (`manager/`) | Daemon headless. Satu-satunya penulis 9 DB SQLite. API loopback HTTP + bearer token (default port 8097, rate limit 60 req/menit). |
| **Panel** (`panel/`) | Web UI SSR terpisah. Auth sendiri (password scrypt + TOTP + recovery codes, session cookie, CSRF). DB sendiri (`users.db`). Tidak pernah menulis DB manager — semua via Manager API. |
| **vmctl** (`bin/vmctl.js`) | CLI `vmctl <noun> <verb>`. Token dari `runtime/sockets/cli-token`. Verb destruktif = two-phase confirm. |

Target host: GitHub Actions runner (sekarang), Ubuntu VPS, container (DESIGN §1.2, §17).

## 2. Layering

```
┌────────────────────────────────────────────────────────────┐
│ Clients: vmctl │ Panel │ GitHub Actions workflow           │
└──────┬──────────────────────┬───────────────────────────────┘
       │ HTTP loopback (bearer)
┌──────▼──────────────────────▼───────────────────────────────┐
│ MANAGER daemon                                              │
│  project/service/deployment/health manager                  │
│  backup/restore/rollback/export/import manager              │
│  audit/permission/secret manager, InternalSupervisor        │
│  adapters: static | node | python                           │
├─────────────────────────────────────────────────────────────┤
│ lib/ SDK: db (WAL, migrate, integrity), crypto, vault,      │
│  lock, redact, paths, config, ids, fsutil, log, api-client  │
├─────────────────────────────────────────────────────────────┤
│ data/ = 9 SQLite DB (WAL) — single writer = manager         │
└──────┬──────────────────────────────────────────────────────┘
       │ child_process spawn (argv array, no shell)
┌──────▼──────────────────────────────────────────────────────┐
│ Project services — workspace + env + port terisolasi        │
│ per project (workspaces/<prj_id>)                           │
└─────────────────────────────────────────────────────────────┘
```

Prinsip utama (DESIGN §2.4):

1. **Single-writer per DB** — hanya manager menulis; panel/vmctl baca via API (atau read-only langsung untuk fast-path).
2. **Everything must die** — setiap proses punya stop procedure + kill timeout; tidak ada proses yatim (PID file `runtime/pid/`).
3. **Fresh-start guarantee** — bootstrap menolak folder non-kosong/asing.
4. **Anti-delete** — tidak ada hapus otomatis DB valid; semua destructive = two-phase confirm.
5. **Migratable** — semua path berbasis config (`config.yaml`); abstraksi host mode `dev | actions | vps | container`.

## 3. Komponen manager

16 modul di `manager/<nama>_manager/index.js` (DESIGN §2.5): project, service, deployment, process, health, recovery (InternalSupervisor), backup, restore, rollback, export, import, audit, permission, secret, lock, resource. Pola: dependency injection via constructor, lazy import di `manager/index.js#startModules()`, tiap modul membuka koneksi DB sendiri dan punya `close()`.

Adapters (`manager/adapters/`, DESIGN §2.6): interface `detect/validate/prepare/install/configure/start/stop/restart/status/health_check/logs/cleanup`. Implementasi aktif: **static** (embedded static server), **node** (`npm ci` + entrypoint), **python** (venv + pip). Tipe `custom` juga diterima ProjectManager. Adapter lain (docker/minecraft/bot) menyusul.

## 4. Model data: 9 database SQLite

Mode WAL, masing-masing punya `schema_migrations` sendiri (runner migrasi transaksional di `lib/db.js`). Manager membuka platform/projects/services saat start; modul lain membuka DB-nya sendiri.

| DB | Isi utama |
|---|---|
| platform.db | meta config (diff-only update), migrations, runner state, storage stats |
| projects.db | projects (+ env refs, workspace path, policy JSON), workspaces |
| services.db | services, service_supervisor_state (restart_count, backoff, crash_loop), deployment_queue, ports |
| deployments.db | deployments, deployment_events, revisions (marker success/rollback-target) |
| health.db | health_checks, health_state, alerts |
| backups.db | backups, backup_items, retention_runs |
| audit.db | audit_events (append-only via trigger), audit_purge_requests |
| users.db | users, sessions, recovery_codes (panel-owned) |
| locks.db | lock_registry, lock_events |

Alasan 9 DB terpisah, bukan 1 (DESIGN §5.4): backup granular per domain, lock contention rendah (audit/health = hot path), blast radius corrupt kecil. Konsistensi lintas-DB dijaga dengan transaksi compensating + `backupset` metadata + integrity check periodik — bukan foreign key (tidak mungkin lintas file SQLite).

Ketahanan DB (`lib/db.js`, DESIGN §5.5): preflight 0-byte/header salah → REFUSE_START_DB (tanpa auto-delete); WAL yatim → checkpoint TRUNCATE dengan salinan cadangan; `PRAGMA integrity_check` saat start/backup/restore; `VACUUM INTO` untuk snapshot konsisten.

## 5. Worker pool & konkurensi

- Pool 4 worker lane async (default config `worker.pool`), queue cap 32 → penuh = `QUEUE_FULL`.
- Lock per-project saat deploy (`deploy-<projectId>`) → deploy kedua ditolak `DEPLOY_IN_PROGRESS`.
- Backup memakai lock global `backup-global` + rate-limit 30 menit (non-manual) → backup kedua ditolak `BACKUP_IN_PROGRESS`.
- Fault isolation per-job: kegagalan satu project tidak mengganggu worker lane lain.

## 6. Isolasi project

Per project (DESIGN §6A): workspace terpisah `workspaces/<prj_id>` (validasi path anti-traversal via `lib/paths.js`), env file sendiri di `runtime/environments/` (global env whitelist — var OS lain di-drop), port terallocasi dari range 10000-65535 (reserved list di `config.yaml`; bind-test + registry + rekonsiliasi anti port-leak), spawn via argv array tanpa shell (anti command injection), secret via `secret://` refs yang di-resolve saat spawn (redaction di semua log/audit).

**Advisory isolation (jujur):** di GitHub Actions runner, project process berjalan sebagai user OS yang sama dengan manager — isolasi bersifat advisory, bukan boundary keamanan asli. Boundary asli hanya di VPS mode (systemd user terpisah). Lihat [SECURITY.md](SECURITY.md) dan DESIGN §12.2, §21.15.

Detail lengkap (ERD, DDL, state machine service/deployment/recovery, self-chain, backup 17 langkah): [DESIGN.md](DESIGN.md) §5-§10, §15-16.
