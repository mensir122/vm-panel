
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


## Failure Simulation Run + Live Chain Drill (GitHub Actions nyata)

| Skenario | Run | Hasil | Bukti |
|---|---|---|---|
| Live chain drill 1 (graceful estafet) | 33872071325 | SUCCESS | restore-decrypt + verify + start + health gate + keepalive + drain + self-chain dispatch |
| Live chain drill 2 (runner baru restore state TERENKRIPSI) | 33873428361 | restore=SUCCESS, health-gate=SUCCESS (dibatalkan setelah bukti tercapai) | artifact vm-state.enc (AES-256-GCM) didekripsi di runner baru |
| Bug ditemukan & diperbaiki via drill nyata | 33860222597..33870967656 | 4 run | RUNNER_ID env leak (hermetic test), panel CLI entrypoint hilang, health probe tanpa bearer token, keepalive job-name + queued-run deteksi, restore extract path |
| Roundtrip state terenkripsi (lokal) | state-container.test.js | 6/6 PASS | encrypt-decrypt, wrong-key, tamper, traversal, empty, usage |

Tanggal: 2026-09-04 UTC. Repo: github.com/mensir122/vm-panel (public).
Kesimpulan: self-chain + encrypted state roundtrip TERBUKTI bekerja di GitHub Actions nyata.
