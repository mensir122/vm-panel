# VM-Panel

VM-Panel adalah control plane + runtime plane untuk mengelola banyak project di satu host (GitHub Actions runner saat ini, VPS nanti) — layaknya VPS pribadi: deploy, service lifecycle, health check, auto-recovery, backup/restore/rollback, audit, dan permission dalam satu sistem.

Tiga komponen:

- **Manager** — daemon headless, satu-satunya penulis database (SQLite, mode WAL).
- **Panel** — web UI terpisah (auth sendiri: password + TOTP + recovery codes; DB sendiri: `users.db`).
- **vmctl** — CLI `vmctl <noun> <verb>`; operasi destruktif wajib two-phase confirm.

Rujukan desain lengkap: [`docs/DESIGN.md`](docs/DESIGN.md). Panduan operasional: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Arsitektur Singkat

```
 vmctl (CLI)          Panel (web 127.0.0.1:8080)
     |   \             /
     |    \           /  HTTP loopback :8097 (bearer token)
     |     ▼         ▼
     |   ┌──────────────────────────┐
     |   │ MANAGER (node manager/ ) │  16 modul + InternalSupervisor
     |   │ API loopback + bearer    │  adapter: static / node / python
     └──►│ runtime/sockets/cli-token│
         └───────────┬──────────────┘
                     | child_process (argv, no shell)
             ┌─────────────────────┐
             │ PROJECT SERVICES    │  workspace + env + port terisolasi
             │ [static] [node] [py]│  per project (workspaces/<prj_id>)
             └─────────────────────┘
```

- Manager API hanya menerima koneksi loopback + bearer token (rate limit 60 req/menit).
- Panel tidak pernah menulis DB manager; semua mutasi via Manager API.
- vmctl membaca token dari `runtime/sockets/cli-token` (dibuat manager saat start).

## Quickstart

Syarat: Node.js >= 20. Satu dependency produksi: `better-sqlite3`.

```bash
# 1. Install dependency
npm install

# 2. Set master key (dipakai vault secret & enkripsi TOTP panel).
#    Minimal 32 karakter acak. JANGAN commit nilainya.
export VPANEL_MASTER_KEY="<acak-minimal-32-karakter>"

# 3. Jalankan manager (API 127.0.0.1:8097; tulis runtime/pid/manager.pid
#    dan runtime/sockets/cli-token)
npm start

# 4. Jalankan panel (127.0.0.1:8080)
npm run start:panel
```

First-run bootstrap:

1. Buka `http://127.0.0.1:8080/bootstrap` — buat akun owner (token setup sekali-pakai, TTL 15 menit).
2. Simpan **TOTP secret** dan **10 recovery codes** yang tampil sekali; tidak pernah muncul lagi.
3. Login di `/login`: username + password + kode TOTP (atau recovery code).
4. Buat project dan deploy via vmctl atau panel:

```bash
# CLI (tanpa install global; pastikan manager berjalan)
node bin/vmctl.js system status
node bin/vmctl.js project create --name demo-web --type static --port 18080
node bin/vmctl.js project deploy prj_xxxxxxxx        # id dari output create
node bin/vmctl.js service list
node bin/vmctl.js service start svc_xxxxxxxx
node bin/vmctl.js service health svc_xxxxxxxx
node bin/vmctl.js backup create
node bin/vmctl.js audit list --limit 5

# Semua command + aturan two-phase confirm:
node bin/vmctl.js help
```

Catatan bootstrap: bootstrap menolak folder yang sudah berisi `platform.db` non-kosong (fresh-start guarantee). Manager gagal start (REFUSE_START_DB) bila integritas database bermasalah — tidak ada auto-delete; lihat `docs/OPERATIONS.md` (troubleshooting).

## Struktur Folder

```
lib/       SDK bersama: db (WAL+migrate+integrity), crypto, vault, lock,
           redact, paths, config, api-client, errors, ids, fsutil, log
manager/   daemon + 16 modul (manager/<nama>_manager/) + manager/adapters/
panel/     server SSR (panel/server/), templates, static, config/panel.yaml
bin/       vmctl.js — CLI entrypoint
data/      9 database SQLite + migrations (platform, projects, services,
           deployments, health, backups, audit, users, locks)
workspaces/ runtime/ logs/ backups/ projects/ secrets/ scripts/ templates/
tests/     unit/ (aktif), integration/, security/, recovery/
docs/      DESIGN.md (sumber kebenaran), ARCHITECTURE, OPERATIONS,
           SECURITY, TESTING, TEST-PLAN, test-report.md
.github/workflows/  workflow runner GHA (vm.yml, recovery.yml — fase F5)
```

Konfigurasi: `config.yaml` (semua default dev, tanpa credential). Contoh env: `.env.example` (`VPANEL_MASTER_KEY`, `MANAGER_API_PORT`, `PANEL_PORT`, `VM_PANEL_ENV`).

## Status Implementasi

Fase F1-F5 (desain §22 D12): **selesai di level modul** — 16 modul manager, 3 adapter (static/node/python), panel SSR + auth TOTP, vmctl, backup/restore/export/import/rollback, InternalSupervisor (crash-loop + backoff 5/15/30/60/120s + manual retry), API data routes.

Sudah diverifikasi unit test (`npm test`, `node:test` bawaan): **388 test hijau** pada 30 file — db/migrate/integrity, crypto/vault, lock, redact, paths, process/project/service/deployment/health manager, internal supervisor, backup/restore, export/import, audit (termasuk purge two-phase), permission, panel auth (scrypt+TOTP+lockout+CSRF), panel server E2E, api server (loopback/bearer/rate-limit), vmctl parser.

Belum terverifikasi (lihat `docs/TEST-PLAN.md`): suite integration/security/recovery eksplisit, simulate 24 skenario (`tests/recovery/simulate.js`), live chain drill GHA (butuh Actions runner). Adapters tambahan (docker/minecraft/bot) masih menyusul.

## Batasan GitHub Actions (penting)

Runner GitHub Actions **bukan VPS**: runner sementara, bisa berhenti kapan saja, job ada batas waktu, IP berubah, storage tidak permanen. Game server berat, website produksi, dan DB produksi tidak ideal di runner. Self-chain mengurangi gap uptime tapi tetap bisa gagal; backup ke storage eksternal wajib untuk state penting. VPS nyata lebih cocok untuk service produksi — panel ini dirancang untuk migrasi mulus ke VPS (DESIGN §17). Detail: DESIGN §20.1.

## Fresh System

Repo ini **100% fresh**: tidak terhubung ke sistem/panel/bot/DB lama mana pun. Semua data saat ini adalah data uji dummy (default dev). Secret hanya via refs (`secrets/secrets.yaml`) + vault terenkripsi (`secrets/vault.enc`); tidak ada nilai rahasia di kode, config, log, atau dokumentasi.
