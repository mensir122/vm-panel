# Live Chain Drill — Checklist (GitHub Actions)

> Tujuan: membuktikan self-chain + recovery watchdog benar-benar bekerja di
> runner Actions sungguhan (satu-satunya item PENDING di docs/TEST-PLAN.md).
> Desain: docs/DESIGN.md §15, D8a-D8c. Laporan hasil di-append ke
> docs/test-report.md (bukti klaim "self-chain bekerja").

## Prasyarat (sekali per repo)

- [ ] Repo **private** di GitHub (mis. `<user>/vm-panel`).
- [ ] Push commit ini: `git remote add origin <url> && git push -u origin main`.
- [ ] Repo secret: `VPANEL_MASTER_KEY` = isi `.env` (JANGAN commit .env —
      sudah di-gitignore). Settings → Secrets and variables → Actions.
- [ ] Workflow permissions: Settings → Actions → General → Workflow permissions
      = "Read and write permissions" (dibutuhkan artifact upload + dispatch;
      workflow file sudah memakai permissions minimal per job).
- [ ] Default branch = `main` (recovery.yml dispatch ke GITHUB_REF_NAME
      fallback main).

## Drill 1 — Graceful chain (happy path)

1. [ ] Actions tab → workflow **vm** → Run workflow (branch main).
2. [ ] Tunggu job `vm / vm` naik → cek langkah: restore_state (fresh pertama
      kali) → verify_state → start manager+panel → health gate lulus.
3. [ ] Tunggu ±5 jam 45 menit (drain window t-15m). Alternatif cepat: edit
      `RUNNER_JOB_MINUTES` env di vm.yml jadi `20` + `RUNNER_DRAIN_MINUTES`
      `5` (drill-only, commit terpisah, revert setelah drill).
4. [ ] Verifikasi: run kedua vm.yml muncul via `gh workflow run` TANPA campur
      tangan manusia; lockfile `runtime/chain-lock.json` di-artifact berisi
      `expires_at`; tidak ada dua run in-progress bersamaan (concurrency).
5. [ ] Run kedua lulus health gate + restore state dari artifact → status
      runner `active` di /system/status. **Drill 1 PASS.**

## Drill 2 — Cancel mid-timeline (net recovery.yml)

1. [ ] Saat run pertama berjalan, **Cancel job** di titik acak (mis. t-10m
      sebelum drain, atau tengah keepalive).
2. [ ] Tunggu ≤ 15 menit (interval cron recovery.yml).
3. [ ] Verifikasi: recovery.yml mendeteksi tidak ada run in-progress + lock
      expired → dispatch vm.yml baru → runner baru restore dari artifact
      `vm-state-*` terakhir yang valid → health gate lulus.
4. [ ] Ulangi cancel di 2-3 titik berbeda (drain window, final backup, restore
      state) — masing-massing harus pulih. **Drill 2 PASS.**

## Drill 3 — Split-brain (dua dispatch hampir bersamaan)

1. [ ] Dispatch vm.yml dua kali dalam < 10 detik dari CLI:
      `gh workflow run vm.yml -R <repo>` x2.
2. [ ] Verifikasi: concurrency group membuat keduanya antre — hanya SATU run
      in-progress; run kedua antre (queued), bukan paralel.
3. [ ] Tidak ada dua manager menulis DB sama di storage eksternal. **PASS.**

## Drill 4 — Kegagalan total dispatch (issue alert)

1. [ ] Hentikan sementara semua run + hapus artifact `vm-chain-lock` (atau
      tunggu expired 2 hari).
2. [ ] Recovery.yml harus dispatch vm.yml + membuat issue `runner-down`
      BILA dispatch gagal (simulasi: revoke workflow permission sementara).
3. [ ] Issue tidak terduplikasi saat watchdog berikutnya jalan. **PASS.**

## Setelah semua drill

- [ ] Append hasil ke `docs/test-report.md`: tabel drill | tanggal UTC |
      run_id | hasil | catatan penyimpangan.
- [ ] Tandai item TEST-PLAN.md `live chain drill` PENDING → PASS.
- [ ] Kembalikan env drill (RUNNER_JOB_MINUTES 360 / DRAIN 15) bila dipakai.
- [ ] Optional: jadwalkan drill ulang bulanan (recovery.yml sudah cron —
      cukup review issue & run history).

## Catatan jujur (batasan yang tetap berlaku)

- Runner Actions = ephemeral: gap uptime 1-3 menit per migrasi, IP berubah,
  storage non-permanen. Uptime SLA hanya di VPS (docs/OPERATIONS.md §VPS).
- Isolasi project di GHA = advisory (satu user OS). Untuk load produksi
  atau project tidak-terpercaya → VPS mode.
- ToS GitHub: jangan jalankan beban 24/7 berat (game server produksi, dsb).
