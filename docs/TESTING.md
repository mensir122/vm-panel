# TESTING.md — Cara Menguji VM-Panel

Test runner: `node:test` bawaan Node (tanpa dependency tambahan). Definisi selesai = `npm test` hijau (AGENTS.md §6-7). Rencana lengkap: [DESIGN.md](DESIGN.md) §18-19. Hasil eksekusi: [test-report.md](test-report.md). Status per requirement user: [TEST-PLAN.md](TEST-PLAN.md).

## 1. Menjalankan suite

```bash
npm test                    # semua test (node --test) — SUITE UTAMA
npm run test:unit           # sama dengan npm test (tests/unit/*.test.js)
npm run test:integration    # tests/integration/*.test.js
npm run test:security       # tests/security/*.test.js
npm run test:recovery       # tests/recovery/*.test.js
```

Status nyata saat ini: **388 test hijau** di `tests/unit/` (30 file). Folder `tests/integration|security|recovery` masih berisi `.gitkeep` — suite eksplisit menyusul; banyak kasus integration/security/recovery sudah tercover unit test masing-masing modul (lihat TEST-PLAN.md).

Test berjalan offline di sandbox directory per run (dummy data, tidak menyentuh data nyata).

## 2. Cakupan tests/unit/ (30 file)

| Area | File test |
|---|---|
| Lib inti | db, schema, crypto, vault, lock, redact, paths, ids, fsutil, log, errors, config |
| Manager modul | project-manager, service-manager, process-manager, deployment, health-manager, internal-supervisor, backup-restore, export-import, audit-manager, permission-manager, adapters |
| API & CLI | api-server (loopback/bearer/rate-limit), api-data-routes, api-client, vmctl |
| Panel | panel-auth (scrypt/TOTP/lockout/recovery), panel-server, panel-e2e |

## 3. Simulasi kegagalan: 24 skenario (DESIGN §19)

Harness `tests/recovery/simulate.js` (rencana F5) menjalankan 24 skenario wajib secara otomatis + assertion + laporan ke `docs/test-report.md`. Daftar skenario:

1. Service mati tiba-tiba (kill -9) → deteksi < 5s, restart sesuai policy
2. Crash-loop (exit 1 loop) → backoff 5/15/30/60/120 → state crash-loop → manual retry
3. Restart limit (>5) → auto-retry berhenti, CRASH_LOOP
4. Health timeout (server dummy hang) → consecutive fail → recovery
5. Manager mati → external supervisor restart, state utuh
6. Panel mati → restart, session valid tetap
7. Runner timeout graceful → self-chain dispatch → restore → health gate
8. DB corrupt (byte-flip) → refuse-start → recovery pipeline → atomic swap
9. WAL/SHM stale → detect → checkpoint + purge → start OK
10. DB kosong/header salah → refuse-start + instruksi manual (no auto-delete)
11. Backup corrupt → verify gagal → tidak replace valid
12. Storage hampir penuh → stop backup non-prioritas + retention + alert
13. Dua deployment bersamaan → satu jalan, satu `DEPLOY_IN_PROGRESS`
14. Dua backup bersamaan → `BACKUP_IN_PROGRESS`
15. Project gagal saat lain jalan → isolasi per project
16. Import checksum salah → reject + rollback point tetap
17. Import path traversal (`../../etc`) → reject + audit
18. Rollback deployment terputus → marker unset → auto-rollback
19. Manager mati di tengah restore → restore journal → resume/rollback idempotent
20. Manager mati di tengah recovery/crash-loop → lock lepas, state konsisten
21. Backup vs deployment konkuren → queue pause, tidak deadlock
22. Cancel GHA di tiap titik timeline (t-15m…t-01m) → recovery.yml net
23. Double-chain split-brain → hanya satu run lanjut
24. Port leak & akumulasi → registry konsisten, rekonsiliasi bersihkan yatim

Setiap skenario wajib membuktikan (DESIGN §19.2): deteksi tercatat, event di-audit, recovery dijalankan, retry dibatasi, status akhir jelas, data valid terakhir tetap ada, tidak ada data valid terhapus, prosedur manual tersedia, hasil recovery diverifikasi.

Skenario 7 dan 22 punya dua versi: CI (mock dispatch API) dan NYATA (live chain drill).

## 4. Live chain drill (DESIGN §19.3, D8c)

Bukti nyata self-chain hanya sah lewat drill sungguhan di GitHub Actions:

- Workflow `chain-drill.yml` (rencana F5): dispatch vm.yml sungguhan, jalankan siklus chain pendek, hasil dilaporkan ke test-report.
- Frekuensi: mingguan (jadwal workflow) atau manual `workflow_dispatch`.
- Status saat ini: **belum dijalankan** — butuh Actions runner aktif; dicatat PENDING di TEST-PLAN.md.

## 5. Coverage & DoD (DESIGN §18.5)

- Target coverage: modul core >= 85%, adapter >= 70%.
- Catatan: di Node 20, coverage `node:test` masih experimental (`--experimental-test-coverage`); pengukuran penuh di CI job Node 22/24.
- Definition of Done per fase: semua suite hijau, 75 kategori test user dieksekusi nyata (checklist di test-report.md), lint/typecheck bersih, `npm audit` tanpa critical.

## 6. Menambah test baru

- Letakkan di `tests/unit/` (atau subfolder suite yang sesuai), nama `*.test.js`.
- Gunakan `node:test` (`import { test } from 'node:test'`) + `node:assert`.
- Sandbox directory per test (fixtures di `tests/fixtures/`); tanpa internet, tanpa data nyata, tanpa secret.
- Failure simulation yang dipakai harness: kill -9, byte-flip file, truncate WAL, quota disk kecil, stale lock, port squat, replay token.
