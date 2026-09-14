# ORIONT Headless VPS (VM-Panel)

ORIONT Headless VPS adalah control plane + runtime plane untuk menjalankan lingkungan layaknya **Linux VPS pribadi 24/7 di atas GitHub Actions** (atau VPS nyata): akses OpenSSH Server port 22 dengan autentikasi SSH key, tunneling persisten (Tailscale / Cloudflare), deployment otomatis, service lifecycle supervisor, health check, auto-recovery, backup/restore/rollback terenkripsi (AES-256-GCM), audit, dan CLI `vmctl`.

Komponen Inti:

- **Headless VPS Runner** — OpenSSH Server port 22 + Reverse Tunnel (Tailscale `vpanel-vps` / Cloudflare / Tmate) di GitHub Actions 24/7 self-chain.
- **Manager Daemon** — engine headless `:8097`, satu-satunya penulis database (SQLite WAL).
- **vmctl CLI** — perkakas terminal `vmctl <noun> <verb>` untuk kontrol penuh dari dalam sesi SSH.

Panduan lengkap akses SSH & VPS: [`docs/PANDUAN-VPS-SSH-247.md`](docs/PANDUAN-VPS-SSH-247.md). Rujukan desain: [`docs/DESIGN.md`](docs/DESIGN.md).

## Arsitektur Singkat

```
 Laptop / Terminal Klien
    │
    │  SSH (Port 22) via Tailscale / Cloudflare / Tmate
    ▼
┌─────────────────────────────────────────────────────────────┐
│ GITHUB ACTIONS HEADLESS RUNNER (ubuntu-latest, 24/7 chain)  │
│                                                             │
│  [OpenSSH Server :22]  ◄── SSH Key Pribadi                  │
│           │                                                 │
│           ▼                                                 │
│      vmctl (CLI)                                            │
│           │                                                 │
│           ▼ (loopback :8097 + bearer token)                 │
│  ┌──────────────────────────┐                               │
│  │ MANAGER (node manager/ ) │  16 modul + Supervisor        │
│  │ API loopback + bearer    │  adapter: static/node/python  │
│  └────────────┬─────────────┘                               │
│               │ child_process (argv, no shell)              │
│       ┌───────┴─────────────┐                               │
│       │ PROJECT SERVICES    │  workspace + port terisolasi  │
│       │ [static] [node] [py]│  per project (workspaces/)    │
│       └─────────────────────┘                               │
└─────────────────────────────────────────────────────────────┘
```

## Quickstart

Syarat: Node.js >= 20. Satu dependency produksi: `better-sqlite3`.

```bash
# 1. Jalankan daemon manager lokal
npm start

# 2. Periksa status sistem via CLI
node bin/vmctl.js system status

# 3. Buat dan deploy project
node bin/vmctl.js project create --name my-service --type node --port 10001
```

Akses SSH 24/7 di GitHub Actions: lihat [`docs/PANDUAN-VPS-SSH-247.md`](docs/PANDUAN-VPS-SSH-247.md).

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
manager/   daemon headless + 16 modul (manager/<nama>_manager/) + manager/adapters/
bin/       vmctl.js — CLI entrypoint
data/      9 database SQLite + migrations (platform, projects, services,
           deployments, health, backups, audit, users, locks)
workspaces/ runtime/ logs/ backups/ projects/ secrets/ scripts/ templates/
tests/     unit/ (aktif), integration/, security/, recovery/
docs/      DESIGN.md, ARCHITECTURE, OPERATIONS, PANDUAN-VPS-SSH-247
.github/workflows/  workflow runner GHA (vm.yml, recovery.yml, ci.yml)
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
