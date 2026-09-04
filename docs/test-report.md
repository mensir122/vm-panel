
## Failure Simulation Run 2026-09-04T06:04:58.187Z

Harness: `tests/recovery/simulate.js` (DESIGN.md §19.3). Skenario 1-4, 8-11, 13-18 sudah tercover unit test (tidak diduplikasi). Skenario 7/12/22 butuh GitHub Actions live drill — di luar scope harness lokal.

| # | Skenario | Hasil | Detail |
|---|----------|-------|--------|
| 6 | Panel mati + external watchdog restart + state utuh | FAIL | Cannot find package '"file:' imported from C:\Users\anjal\Documents\VM-Panel\tests\recovery\simulate.js |

Total: 1 skenario — 1 FAIL.


## Failure Simulation Run 2026-09-04T06:34:41.002Z

Harness: `tests/recovery/simulate.js` (DESIGN.md §19.3). Skenario 1-4, 8-11, 13-18 sudah tercover unit test (tidak diduplikasi). Skenario 7/12/22 butuh GitHub Actions live drill — di luar scope harness lokal.

| # | Skenario | Hasil | Detail |
|---|----------|-------|--------|
| 5 | Manager mati + external watchdog restart + state utuh | PASS | SIGKILL → watchdog restart (≤3/menit, event tercatat) → /health 200 → row platform pre-kill utuh |
| 6 | Panel mati + external watchdog restart + state utuh | PASS | SIGKILL → watchdog restart (port 55447 → 55449, event tercatat) → /login 200 → owner users.db utuh |
| 19 | Manager mati di tengah restore → restore ulang idempotent | PASS | 2x crash mid-restore (marker & mid-swap) → restore ulang deteksi marker → idempotent sukses → snapshot utuh, marker+staging bersih, snapshot asli tak tersentuh |
| 20 | Supervisor mati mid-recovery → supervisor baru lanjut konsisten | PASS | stop() di antara backoff → supervisor baru (state sama) lanjut: rc 0→1→2, backoff 15s/30s konsisten → manualRetry → recovered (3 attempt, dibatasi) |
| 21 | Backup vs deployment konkuren → tidak deadlock | PASS | backup sukses (row + verify valid) + deploy sukses (events per stage) — tanpa deadlock, guard 60s |
| 23 | Split-brain: dua chain leader rebutan runner.lock | PASS | dua leader proses: tepat 1 winner runner.lock, loser LOCK_HELD (gagal bersih); TTL + acquireAll leksikografis + releaseAll terverifikasi |
| 24 | Port leak & rekonsiliasi registry | PASS | kill manual → release-on-exit melepas port 28090; orphan row 24773 dibersihkan rekonsiliasi bind-test (event tercatat); service utuh & start ulang OK |

Total: 7 skenario — semua PASS.

