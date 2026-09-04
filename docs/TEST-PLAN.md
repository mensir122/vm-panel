# TEST-PLAN.md — Checklist 75 Test Requirement (DESIGN §18.2)

Pemetaan 75 requirement test user ke suite implementasi. Status jujur per 2026-09-04:

- **PASS** = terverifikasi oleh test yang benar-benar dijalankan (`npm test` hijau, 388 test di `tests/unit/`).
- **PENDING** = belum terverifikasi eksekusi nyata (suite eksplisit/harness/live drill menyusul) — klaim hanya boleh setelah hijau.

Suite: U = `tests/unit/*`, I = `tests/integration/*` (rencana), S = `tests/security/*` (rencana), R = `tests/recovery/*` (rencana), CI = pipeline (rencana), SIM = `tests/recovery/simulate.js` (rencana F5).

## A. Install, bootstrap, lifecycle dasar (#1-13)

| # | Requirement | Suite | Evidence | Status |
|---|---|---|---|---|
| 1 | Fresh bootstrap: folder kosong diterima | U | tests/unit/project-manager.test.js (workspace baru), tests/unit/db.test.js | PASS |
| 2 | Bootstrap menolak folder non-kosong/DB asing | U | tests/unit/db.test.js (preflight header/0-byte) | PASS |
| 3 | Migrasi schema idempotent (platform/projects/services) | U | tests/unit/db.test.js, tests/unit/schema.test.js | PASS |
| 4 | Manager start/stop graceful (PID file, audit startup/shutdown) | U | tests/unit/api-server.test.js | PASS |
| 5 | Project create static (validasi nama/type/port) | U | tests/unit/project-manager.test.js | PASS |
| 6 | Project create node | U | tests/unit/project-manager.test.js | PASS |
| 7 | Project create python | U | tests/unit/project-manager.test.js, tests/unit/adapters.test.js | PASS |
| 8 | Adapter static: serve file via embedded static server | U | tests/unit/adapters.test.js | PASS |
| 9 | Adapter node: install + start (verify-command, dummy) | U | tests/unit/adapters.test.js | PASS |
| 10 | Adapter python: venv + entrypoint (verify-command, dummy) | U | tests/unit/adapters.test.js | PASS |
| 11 | Deploy pipeline end-to-end (detect→…→health→marker) | U | tests/unit/deployment.test.js | PASS |
| 12 | Start/stop/restart service + PID/exit tracking | U | tests/unit/service-manager.test.js, tests/unit/process-manager.test.js | PASS |
| 13 | Deploy concurrent (worker pool, queue) | I+SIM | rencana (queue/lock tercover unit: deployment.test.js DEPLOY_IN_PROGRESS) | PENDING |

## B. Validasi input (#13b-17)

| # | Requirement | Suite | Evidence | Status |
|---|---|---|---|---|
| 14 | Port conflict ditolak / bind gagal → service failed + audit | U | tests/unit/process-manager.test.js, tests/unit/project-manager.test.js | PASS |
| 15 | Port illegal (<10000, reserved) ditolak | U | tests/unit/project-manager.test.js, tests/unit/process-manager.test.js | PASS |
| 16 | Nama project duplikat ditolak | U | tests/unit/project-manager.test.js | PASS |
| 17 | Repo/branch invalid ditolak (repo_url/branch field) | I | rencana (validasi repo belum dibutuhkan alur workspace) | PENDING |

## C. Keamanan (#18-30)

| # | Requirement | Suite | Evidence | Status |
|---|---|---|---|---|
| 18 | Path traversal workspace ditolak | U | tests/unit/paths.test.js, tests/unit/panel-server.test.js (static dir) | PASS |
| 19 | Command injection ditolak (argv no-shell) | U | tests/unit/health-manager.test.js (command check argv-only) | PASS |
| 20 | Symlink escape ditolak | U | tests/unit/paths.test.js | PASS |
| 21 | Request tanpa auth ditolak (401/403) | U | tests/unit/api-server.test.js, tests/unit/panel-server.test.js | PASS |
| 22 | Login password salah ditolak + audit | U | tests/unit/panel-auth.test.js | PASS |
| 23 | TOTP salah ditolak | U | tests/unit/panel-auth.test.js | PASS |
| 24 | Session expiry/revoked ditolak | U | tests/unit/panel-auth.test.js | PASS |
| 25 | CSRF ditolak (double-submit, token terikat session) | U | tests/unit/panel-auth.test.js, tests/unit/panel-server.test.js, tests/unit/panel-e2e.test.js | PASS |
| 26 | Permission matrix (viewer tidak bisa aksi operator) | U | tests/unit/permission-manager.test.js | PASS |
| 27 | Scoping per-project (viewer hanya project ter-scope) | U | tests/unit/permission-manager.test.js | PASS |
| 28 | Lockout 5 gagal / 15 menit | U | tests/unit/panel-auth.test.js | PASS |
| 29 | Redaction log (pattern + nilai secret aktif) | U | tests/unit/redact.test.js | PASS |
| 30 | Redaction audit/error (input disanitasi sebelum insert) | U | tests/unit/redact.test.js, tests/unit/audit-manager.test.js | PASS |

## D. Backup/restore/export/import (#31-43)

| # | Requirement | Suite | Evidence | Status |
|---|---|---|---|---|
| 31 | Backup pipeline (lock→VACUUM INTO→manifest→sha256→verify) | U | tests/unit/backup-restore.test.js | PASS |
| 32 | Checksum manifest cocok (read-back) | U | tests/unit/backup-restore.test.js | PASS |
| 33 | Backup corrupt ditolak (verify gagal, tidak replace valid) | U+SIM | tests/unit/backup-restore.test.js; SIM #11 | PASS |
| 34 | DB corrupt → refuse-start (0-byte/header salah) | U | tests/unit/db.test.js | PASS |
| 35 | DB corrupt → recovery pipeline (staging+atomic swap) | U+R | tests/unit/backup-restore.test.js (restore pre-flight); R rencana | PASS (restore) / PENDING (R full) |
| 36 | WAL/SHM stale ditangani saat start | U | tests/unit/db.test.js (wal orphan checkpoint) | PASS |
| 37 | Restore backup (staging, rollback point, atomic) | U | tests/unit/backup-restore.test.js | PASS |
| 38 | Rollback deployment ke revision sukses | U | tests/unit/deployment.test.js, tests/unit/api-data-routes.test.js | PASS |
| 39 | Export project/all (manifest, checksum) | U | tests/unit/export-import.test.js | PASS |
| 40 | Export terenkripsi (AES-256-GCM, PBKDF2 600k) | U | tests/unit/export-import.test.js, tests/unit/vault.test.js | PASS |
| 41 | Import valid (staging, integrity, health post) | U | tests/unit/export-import.test.js | PASS |
| 42 | Import checksum salah ditolak | U+SIM | tests/unit/export-import.test.js; SIM #16 | PASS |
| 43 | Import traversal ditolak (no ../, absolute, symlink) | U+SIM | tests/unit/export-import.test.js, tests/unit/paths.test.js; SIM #17 | PASS |

## E. Supervisor & recovery (#44-50)

| # | Requirement | Suite | Evidence | Status |
|---|---|---|---|---|
| 44 | Deployment fail → stage+error tersimpan, retry tersedia | U | tests/unit/deployment.test.js | PASS |
| 45 | Service mati → deteksi + restart policy | U+SIM | tests/unit/internal-supervisor.test.js; SIM #1 | PASS |
| 46 | Backoff eksponensial 5/15/30/60/120 + reset window 600s | U+SIM | tests/unit/internal-supervisor.test.js; SIM #2 | PASS |
| 47 | Restart limit → CRASH_LOOP, auto-retry berhenti | U+SIM | tests/unit/internal-supervisor.test.js; SIM #3 | PASS |
| 48 | Crash-loop → audit + notifikasi + manual retry | U+SIM | tests/unit/internal-supervisor.test.js (manualRetry); SIM #2 | PASS |
| 49 | Health timeout + consecutive failure threshold | U | tests/unit/health-manager.test.js, tests/unit/internal-supervisor.test.js | PASS |
| 50 | Manager death → external supervisor restart < 15s | R+SIM | rencana (R suite + SIM #5; butuh harness proses) | PENDING |

## F. Runner/self-chain (#51-57)

| # | Requirement | Suite | Evidence | Status |
|---|---|---|---|---|
| 51 | Panel death → restart, session valid tetap | R+SIM | rencana (SIM #6; panel auth session tercover unit) | PENDING |
| 52 | Runner timeout graceful → drain → final backup | R+SIM | rencana (SIM #7) | PENDING |
| 53 | Self-chain dispatch → runner baru | R+SIM | rencana (SIM #7) | PENDING |
| 54 | Restore-state runner baru + integrity gate | R+SIM | rencana (SIM #7; restore tercover unit) | PENDING |
| 55 | Health gate post-restore wajib lulus | R+SIM | rencana (SIM #7) | PENDING |
| 56 | Project fail isolation (A gagal, B tetap jalan) | U+SIM | tests/unit/deployment.test.js (error isolation per job); SIM #15 | PASS |
| 57 | Cancel GHA di tiap titik timeline → recovery.yml net | R+SIM+LIVE | rencana (SIM #22) | PENDING |

## G. Adapters lanjutan (#58-63)

| # | Requirement | Suite | Evidence | Status |
|---|---|---|---|---|
| 58 | Docker adapter (compose up/verify) | I | rencana (adapter belum diimplementasi) | PENDING |
| 59 | Minecraft Java verify-command (dummy binary) | I | rencana (adapter belum diimplementasi) | PENDING |
| 60 | Minecraft Bedrock verify-only | I | rencana (adapter belum diimplementasi) | PENDING |
| 61 | Hermes adapter (dummy repo) | I | rencana (adapter belum diimplementasi) | PENDING |
| 62 | Router adapter (config template, port) | I | rencana (adapter belum diimplementasi) | PENDING |
| 63 | Rollback deployment terputus (auto-rollback) | U+SIM | tests/unit/deployment.test.js, tests/unit/api-data-routes.test.js; SIM #18 | PASS (unit) / PENDING (SIM) |

## H. Konkurensi & storage (#64-68)

| # | Requirement | Suite | Evidence | Status |
|---|---|---|---|---|
| 64 | Dua deployment paralel → DEPLOY_IN_PROGRESS | U+SIM | tests/unit/deployment.test.js; SIM #13 | PASS |
| 65 | Dua backup paralel → BACKUP_IN_PROGRESS (lock global) | U+SIM | tests/unit/backup-restore.test.js; SIM #14 | PASS |
| 66 | Storage hampir penuh → stop backup non-prioritas + alert | R+SIM | rencana (SIM #12; retention tercover unit) | PENDING |
| 67 | Retention (latest 3/daily 7/weekly 4; manual never) | U | tests/unit/backup-restore.test.js | PASS |
| 68 | Export→import round-trip all (fresh host) | U+I | tests/unit/export-import.test.js | PASS |

## I. Kualitas CI (#69-75)

| # | Requirement | Suite | Evidence | Status |
|---|---|---|---|---|
| 69 | Unit tests lengkap hijau | U | `npm test` (388 pass) | PASS |
| 70 | Integration tests hijau | I | suite eksplisit rencana | PENDING |
| 71 | Security tests hijau | S | suite eksplisit rencana (kasus tercover unit #18-30) | PENDING |
| 72 | Lint | CI | rencana pipeline | PENDING |
| 73 | Type check (tsc --noEmit + checkJs) | CI | rencana pipeline | PENDING |
| 74 | Syntax check (parse semua file JS) | CI | rencana pipeline | PENDING |
| 75 | No-internet test (offline first) | CI | rencana (test saat ini offline by construction) | PENDING |

## Rekap

- PASS: item dengan evidence unit test yang dijalankan (lihat tabel).
- PENDING: (1) suite eksplisit integration/security/recovery, (2) harness `simulate.js` 24 skenario, (3) live chain drill GHA (SIM #7/#22 versi nyata), (4) adapters docker/minecraft/hermes/router, (5) CI lint/type/syntax.
- Aturan: item PENDING hanya boleh jadi PASS setelah test terkait benar-benar hijau; hasil eksekusi dicatat di [test-report.md](test-report.md).
