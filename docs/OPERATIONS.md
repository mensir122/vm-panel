# OPERATIONS.md — Panduan Operasional

Praktis dan ringkas. Contoh command diambil dari CLI aktual (`bin/vmctl.js`) dan endpoint nyata (`manager/api.js`, `manager/api-data-routes.js`). Detail desain: [DESIGN.md](DESIGN.md). Segala operasi destruktif = two-phase confirm (ketik persis target ID untuk melanjutkan).

## 0. Persiapan

```bash
npm install
export VPANEL_MASTER_KEY="<acak-minimal-32-karakter>"   # atau keyfile mode 600
npm start              # manager, API 127.0.0.1:8097
npm run start:panel    # panel, 127.0.0.1:8080
node bin/vmctl.js system status   # cek manager hidup
```

Bootstrap first-run (owner pertama): buka `http://127.0.0.1:8080/bootstrap`, buat owner, simpan TOTP secret + 10 recovery codes (tampil sekali). Login di `/login` dengan password + kode TOTP. Token CLI otomatis tersedia di `runtime/sockets/cli-token` (dibaca vmctl); override dengan `--token` atau env `VM_PANEL_TOKEN`.

## 1. Membuat project tiap tipe

Tipe yang diterima ProjectManager: `static`, `node`, `python`, `custom` (registry adapter: `manager/adapters/index.js`). Nama: lowercase, `[a-z0-9][a-z0-9-]{1,62}`. Port opsional, harus 10000-65535 dan bukan port reserved (`config.yaml: ports.reserved`).

```bash
# static — file statis dilayani embedded static server manager
node bin/vmctl.js project create --name demo-web --type static --port 18080

# node — npm ci (lockfile pin) + entrypoint node
node bin/vmctl.js project create --name demo-api --type node --port 18081

# python — venv per project + pip install + entrypoint
node bin/vmctl.js project create --name demo-bot --type python

# custom — start command milik user (diisi lewat registry/panel)
node bin/vmctl.js project create --name demo-job --type custom
```

Deploy (pipeline adapter: detect → validate → prepare → install → configure → start → health):

```bash
node bin/vmctl.js project deploy prj_xxxxxxxx      # source: workspace
node bin/vmctl.js deployment list --project prj_xxxxxxxx
node bin/vmctl.js deployment show dep_xxxxxxxx     # detail + events per stage
```

Setelah deploy sukses, service dibuat; kelola via `service`:

```bash
node bin/vmctl.js service list
node bin/vmctl.js service show svc_xxxxxxxx
node bin/vmctl.js service start|stop|restart svc_xxxxxxxx
node bin/vmctl.js service health svc_xxxxxxxx      # satu probe on-demand
# service logs masih stub CLI — tail via API: GET /logs/:serviceId (200 baris)
curl -H "Authorization: Bearer $VM_PANEL_TOKEN" http://127.0.0.1:8097/logs/svc_xxxxxxxx
```

Catatan: `project start/stop/restart/logs/remove/archive/restore` masih stub CLI (exit 2, not implemented) — gunakan `service ...` untuk lifecycle. Deploy ganda pada project yang sama ditolak `DEPLOY_IN_PROGRESS` (lock per project).

## 2. Deployment & rollback

- Status deployment: `pending → running(stage) → success | failed | rolled_back`. Tiap stage tercatat di `deployment_events` (lihat `deployment show`).
- Health gagal setelah start baru → pipeline gagal, stage terakhir tersimpan.
- Rollback ke revision sukses terakhir (marker `success` di tabel `revisions`):

```bash
node bin/vmctl.js deployment rollback dep_xxxxxxxx   # destructive: two-phase confirm
node bin/vmctl.js deployment retry dep_xxxxxxxx      # deployment ulang dari yang gagal
```

Catatan CLI: `deployment rollback|retry|logs` masih stub (exit 2, not implemented) — pipeline rollback/retry di level DeploymentManager/RollbackManager sudah ada; jalankan via Manager API/panel sampai CLI menyusul.

- Deployment terputus (manager/runner mati di tengah deploy) → saat recovery, RollbackManager melihat deployment RUNNING melewati timeout tanpa marker → auto-rollback ke revision sukses terakhir + audit `AUTO_ROLLBACK_DISCONNECTED` (DESIGN §7.3).

## 3. Monitoring & health

Tipe health check yang diimplementasi (`manager/health_manager/index.js`): `http` (GET + expectStatus/expectContent, timeout 5s), `tcp` (connect test, 3s), `command` (exit 0, 15s), `process` (PID alive). Interval default 30s per service.

Membaca status via panel: halaman Health/Services memakai kelas dot CSS:

| Dot | Arti |
|---|---|
| `dot--healthy` (hijau) | health pass |
| `dot--degraded` (kuning) | pass dengan warning (mis. resource) |
| `dot--unhealthy` / `dot--crash_loop` (merah) | health fail berturut-turut / berhenti auto-retry |
| `dot--stopped` / `dot--disabled` (abu) | dihentikan / dinonaktifkan |
| `dot--unknown` (garis putus) | belum pernah di-check |

Endpoint API terkait (semua loopback + bearer):

- `GET /health` — liveness manager (ok/fail; juga `node bin/vmctl.js health`).
- `GET /system/status` — status manager (uptime, host mode, runner id).
- `GET /health-state?serviceId=svc_x` — status + N check terakhir.
- `GET /recovery/status` — supervisor state per service (state, restarts, crash_loop, backoff_until).
- `GET /ports` — registry port.

Escalation: health fail berturut-turut >= 3 → recovering; restart ke-3 → notifikasi "degrading"; crash-loop → notifikasi "manual intervention" (webhook, DESIGN §8.5).

## 4. Auto-recovery & crash-loop

Yang terjadi otomatis (InternalSupervisor, loop 5s per service):

1. Proses mati (exit != 0, policy on-failure) → restart dengan backoff **5s, 15s, 30s, 60s, 120s**.
2. `restart_count` hanya di-reset setelah stabil 600s — tidak pernah di-reset oleh restart manager/migrasi.
3. Restart mencapai `max_restarts` (default 5) → state **CRASH_LOOP**: auto-retry berhenti, audit `CRASH_LOOP_DETECTED`, webhook "manual retry required", status health failed.

Kapan butuh manual retry: setiap kali supervisor state `crash_loop = yes` (lihat `vmctl recovery status` atau halaman Recovery di panel). Supervisor tidak akan menyentuh service itu lagi sampai di-retry manual.

Cara manual retry:

```bash
node bin/vmctl.js recovery status                  # lihat crash_loop + backoff
# via API langsung (permisi service.start):
curl -X POST -H "Authorization: Bearer $VM_PANEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serviceId":"svc_xxxxxxxx"}' \
  http://127.0.0.1:8097/recovery/retry
# atau tombol Retry di panel (halaman Recovery)
```

Sebelum retry, perbaiki penyebabnya (cek log service via `GET /logs/:serviceId` — port bentrok, config salah, dependency gagal). Catatan: `POST /recovery/retry` menolak dengan error validasi bila supervisor belum aktif (InternalSupervisor tidak auto-start; aktifkan via `config.yaml` → `supervisor.autoStart: true` atau mulai supervisor secara eksplisit).

## 5. Backup, restore, retention

Backup = direktori `backups/<kelas>/<backupId>/` berisi `manifest.json` + `files/*.gz` (snapshot DB via `VACUUM INTO`, gzip per file, sha256, verifikasi read-back). Verifikasi gagal → status `failed`, tidak pernah menggantikan backup valid.

```bash
node bin/vmctl.js backup create      # manual (kelas 'manual', tidak dihapus retention)
node bin/vmctl.js backup list        # id, waktu, trigger, kelas, verifikasi, ukuran
```

Restore (owner, two-phase; staging + rollback point dulu, atomic swap setelah pre-flight integrity):

```bash
# via API: POST /backups tidak punya restore route — restore dijalankan
# RestoreManager.restoreBackup(backupId) (dryRun tersedia); CLI backup restore stub.
# Panel: halaman Backups (permisi backup.create) memicu backup manual.
```

Retention default (config `backup.retention`): latest 3, daily 7, weekly 4; **manual/export tidak pernah dihapus**. Row retention kedaluwarsa ditandai `expired`, bukan dihapus. Rate-limit backup otomatis 30 menit; backup kedua paralel ditolak `BACKUP_IN_PROGRESS` (lock global). Storage: free < 20% warning, < 10% critical (DESIGN §9.4).

## 6. Export / import

```bash
node bin/vmctl.js export project prj_xxxxxxxx   # archive project (registry+policies; tanpa secret)
node bin/vmctl.js export all                    # seluruh state manager
node bin/vmctl.js import project <archive>      # destructive: two-phase confirm
node bin/vmctl.js import all <archive>
```

Catatan: kedua verb masih stub CLI (exit 2 setelah confirm) — mesin export/import ada di modul; lihat catatan di bawah.

- Export terenkripsi (AES-256-GCM, PBKDF2-SHA256 600k iterasi, butuh password) tersedia di ExportManager (`encrypted: true`); secret vault hanya ikut pada export terenkripsi.
- Import memvalidasi: archive, manifest, checksum per-file, schema, ID bentrok; menolak path traversal (`../`, absolute, symlink) dan ekstensi tak-diwhitelist; membuat rollback point (backup pre-import) sebelum atomic swap; gagal → auto-restore rollback point.
- Status CLI F3: `export|import` di vmctl masih stub — setelah two-phase confirm mengembalikan exit 2. Mesin export/import (ExportManager/ImportManager) sudah ada di level modul; hubungkan via Manager API/programmatic sampai CLI menyusul.

## 7. Audit log & purge two-phase

Semua operasi penting tercatat append-only (`audit.db`, trigger `no_delete`). Event 22 field; input disanitasi (redaction) sebelum insert.

```bash
node bin/vmctl.js audit list --limit 20
node bin/vmctl.js audit list --actor system --operation service.start --project prj_xxxxxxxx
```

Purge (owner only, dua fase, wajib reason; TTL token 10 menit):

1. `AuditManager.purgeRequest({reason, actor, beforeIso})` → `requestId` + `confirmToken` (hash disimpan di meta).
2. `AuditManager.purgeExecute({requestId, confirmToken, actor})` → DELETE dalam satu transaksi + event baru `AUDIT_PURGE` (metadata range + jumlah — jejak purge tidak hilang).

Tidak ada endpoint CLI purge; purge dieksekusi programmatically/panel oleh owner.

## 8. Users & permissions

Role (DESIGN §11.1-11.2):

| Aksi | owner | operator | viewer |
|---|---|---|---|
| lihat project/status/health/log | ya | ya | ya (scoped) |
| deploy, start/stop/restart | ya | ya | tidak |
| backup create | ya | ya | tidak |
| project create/delete | ya | tidak | tidak |
| backup restore, deployment rollback | ya | tidak | tidak |
| secret view (metadata saja) | ya | tidak | tidak |
| permission/user manage | ya | tidak | tidak |
| audit view | ya | ya | tidak |
| audit purge, export/import | ya | tidak | tidak |

Kelola user lewat panel halaman Users (permisi `user.manage`): create-user (status inactive), approve-user, set-role. Nilai secret tidak pernah ditampilkan di panel/API — hanya metadata ref. Scoping per-project via `project_scopes` (users.db); tanpa row scope = semua project sesuai role. Cache permission 60s.

## 9. Troubleshooting

**Manager mati / tidak merespons**
- Cek PID: `runtime/pid/manager.pid`; cek log `logs/manager/`. Jalankan ulang `npm start`.
- Refuse start dengan kode `REFUSE_START_DB` → integritas DB gagal; lanjut ke prosedur DB corrupt di bawah. Tidak ada auto-delete.

**DB corrupt — prosedur manual restore (DESIGN §5.5)**
1. Stop manager (jangan paksa delete DB).
2. Identifikasi backup valid terakhir: `node bin/vmctl.js backup list` (kolom VERIFY = valid) atau `backups/<kelas>/<id>/manifest.json`.
3. Jalankan restore via RestoreManager (staging → integrity pre-flight → rollback point → atomic rename). Bila butuh salvage manual: salin DB ke temp, jalankan `sqlite3 <copy> ".recover"`, verifikasi `PRAGMA integrity_check`, baru swap — DB asli tidak pernah dihapus otomatis.
4. Start manager; cek `vmctl health` + audit event recovery.

**Port bentrok**
- Gejala: service gagal start, error bind (`EADDRINUSE`). Cek `vmctl service show` (port), `GET /ports` (registry), proses lain yang memegang port (`netstat -ano | findstr <port>` di Windows / `ss -ltnp` di Linux).
- Port reserved ada di `config.yaml` (22, 80, 443, 8080, 8097); allocation range 10000-65535. Port registry dilepas otomatis saat service exit/remove; rekonsiliasi periodik membersihkan yatim.

**WAL stale**
- Gejala: file `data/*.db-wal`/`-shm` tersisa tanpa writer (crash sebelumnya). `lib/db.js` menangani otomatis saat start: salinan cadangan `.tmp-*` dibuat, `wal_checkpoint(TRUNCATE)` via koneksi probe, start lanjut. Bila tetap gagal, checkpoint manual: `sqlite3 data/platform.db "PRAGMA wal_checkpoint(TRUNCATE);"`.

**Panel 401 / login gagal**
- 401 setelah login → faktor kedua salah (TOTP/recovery); pastikan jam server akurat (TOTP window ±1).
- Akun terkunci: 5 gagal → lock 15 menit; tunggu atau owner unlock via users.db (jangan edit sembarangan).
- Session kadaluarsa: TTL 8 jam — login ulang.
- Panel banner "Manager tidak terjangkau" → manager mati; panel tetap hidup tapi data kosong.

**TOTP hilang**
- Gunakan salah satu **recovery code** (10 kode sekali pakai, disimpan saat bootstrap) pada form login. Kode terpakai tidak bisa dipakai lagi.
- Semua recovery code habis/secret benar-benar hilang → owner lain dapat me-reset user; bila satu-satunya owner, satu-satunya jalur adalah membuat user baru via DB panel oleh operator host (dokumentasikan di audit) — bootstrap `/bootstrap` sudah tertutup permanen setelah owner pertama ada.

**Storage penuh**
- Gejala: backup gagal / warning storage. Threshold: free < 20% warning, < 10% critical (backup otomatis berhenti, manual tetap boleh).
- Aksi: jalankan retention (otomatis berjalan), hapus backup lama kelas latest/daily yang sudah expired, pindahkan `backups/` ke volume lain (path via config), perbesar disk. Backup kelas manual/export tidak dihapus otomatis — evaluasi manual.

## 10. Runner GitHub Actions: self-chain

Cara kerja (DESIGN §15):

1. Job vm.yml berjalan max ~6 jam; sisa waktu dihitung dari `started_at` job via GitHub API (bukan jam runner).
2. t-15m → phase draining (tolak deployment baru); t-12m → drain queue; t-10m → checkpoint DB + WAL truncate; t-08m → final backup (kelas latest) + verify; t-06m → dispatch runner berikutnya via `workflow_dispatch` + GITHUB_TOKEN (`permissions: actions: write`); t-03m → stop services; t-01m → stop panel/manager.
3. Runner baru: restore-state dari backup → integrity check → start manager → supervisor sweep → health gate wajib lulus → phase active.
4. Anti split-brain: `concurrency: group vm-chain`, `runner.lock` berisi `{run_id, expires_at, chain_epoch}`; `chain_depth` dibatasi (default 100).

Drain: queue deployment di-pause saat backup/final; deployment yang sedang berjalan diselesaikan atau dibatalkan dengan marker sesuai state (disconnect → auto-rollback, lihat §2).

Watchdog `recovery.yml` (cron 15 menit): jika tidak ada run vm.yml aktif DAN lock kedaluwarsa (ambang stale 30 menit) → dispatch vm.yml baru (retry 3x backoff 60s; gagal terus → issue otomatis label `runner-down`).

Keterbatasan (DESIGN §20-21): uptime tidak terjamin (gap ±1-3 menit per chain), job bisa dicancel kapan saja, IP berubah, storage lokal hilang tiap runner (backup eksternal wajib untuk state penting), isolasi project advisory (lihat SECURITY.md), beban berat (game server produksi) dilarang di runner. Self-chain bisa gagal (API limit) — watchdog memitigasi, tidak menjamin.

## 11. Migrasi ke VPS (DESIGN §17)

1. **Systemd units** (Ubuntu): `vpanel-manager.service`, `vpanel-panel.service`, `vpanel-supervisor.service` — `Restart=always`, `WatchdogSec=300`, sandbox directives (`ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`). Supervisor eksternal = systemd; self-chain tidak dipakai (`host.mode: vps`).
2. **Reverse proxy** (Caddy/Nginx, TLS otomatis): panel domain → 127.0.0.1:8080; project exposure via subdomain/path mapping ke port service; firewall hanya 80/443 + SSH. Manager API (8097) tetap loopback — jangan pernah expose.
3. **Storage backup**: mount/S3/SFTP via rclone atau cron sync; retention tetap dikelola BackupManager.
4. **Checklist migrasi**:
   - Pre: backup terakhir verify `valid`; storage target siap; DNS mengarah; Node >= 20 terpasang.
   - Migrasi: stop sumber → final backup → transfer export/backup → bootstrap di VPS (folder kosong) → restore → integrity check → start manager + panel → health gate.
   - Post: monitor 24 jam; decommission host lama; audit event `MIGRATION_COMPLETE`.
5. Script pembantu `scripts/migrate-to-vps.sh` (setup dependency + restore + systemd enable + verify) — cek keberadaan file sebelum dipakai; fallback: ikuti langkah manual di atas.

## 12. Referensi cepat

| Kebutuhan | Perintah/lokasi |
|---|---|
| Status manager | `node bin/vmctl.js system status` |
| Liveness | `node bin/vmctl.js health` |
| Log manager | `logs/manager/`, log deployment `logs/deployment/`, log project `logs/projects/` (tail via `GET /logs/:serviceId`) |
| Audit | `node bin/vmctl.js audit list [--limit N --actor A --operation OP --project ID]` |
| Recovery state | `node bin/vmctl.js recovery status` |
| Token CLI | `runtime/sockets/cli-token` (otomatis), env `VM_PANEL_TOKEN`, flag `--token` |
| Konfigurasi | `config.yaml` (default dev), env override: `MANAGER_API_PORT`, `PANEL_PORT`, `VM_PANEL_ENV` |
