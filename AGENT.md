# AGENT.md — Konteks Lanjutan untuk AI Session Berikutnya

> File ini PENDUKUNG `AGENTS.md` (aturan repo). `AGENTS.md` = aturan keras. File ini = konteks cerita project + status terkini + rencana.
> **BACA FILE INI DULU sebelum mengerjakan apa pun**, agar tidak mengulang riset dan tidak melanggar kesepakatan dengan pemilik.

---

## 1. SIAPA PEMILIKNYA (WAJIB DIPAHAMI AI BARU)

- Pemilik adalah **orang awam (non-programmer)**. Selalu jelaskan dengan **bahasa awam + analogi** (contoh: VPS = rumah, GitHub Actions = kamar hotel yang diusir tiap 6 jam).
- Pemilik memilih **"Cara 1"**: AI hanya jadi **navigasi/pandu klik** di browser (panel di `http://127.0.0.1:8080`), pemilik yang klik semua tombol. JANGAN kerjakan langsung tanpa diminta — pandu dulu.
- Pemilik berbahasa Indonesia. Berarti: semua penjelasan pakai Bahasa Indonesia.
- Pemilik MUDAH BINGUNG dengan istilah teknis. Kalau harus pakai istilah, segera terjemahkan.
- Sesuai aturan repo (AGENTS.md §8): **JANGAN klaim "jalan/live" tanpa bukti nyata** (test hijau, port merespons). Pemilik sudah percaya karena kita selalu tunjukkan bukti.

## 2. TUJUAN AKHIR PEMILIK (INI NORTH STAR)

**VISI BESAR pemilik: VM-Panel adalah PLATFORM HOSTING PRIBADI untuk BANYAK project — bukan untuk satu bot saja.**

- Pemilik akan **mendeploy BANYAK bot Telegram / aplikasi lain** ke depannya, satu per satu, di platform ini.
- 9Router + bot hermes hanyalah **KASUS PERTAMA / UJI COBA** (lihat §3) — bukan tujuan akhir. Jangan tulis rencana yang mengunci ke satu kasus.
- Pola yang diinginkan pemilik: *"punya bot/aplikasi baru → daftarkan → deploy → jalan 24/7 tanpa laptop"* — diulang untuk setiap project baru.
- Bot tertentu (seperti hermes agent) mungkin butuh **9Router sebagai penyedia model AI** (combos). Kalau ada project yang butuh, 9Router ikut di-deploy sebagai "penyedia otak" di tempat yang sama.
- Pemilik sempat bertanya "apakah GitHub Actions bisa jadi kayak VPS?" — jawaban yang sudah disepakati: **bisa dipaksa mirip VPS** via mekanisme self-chain VM-Panel, tapi bukan VPS beneran (tidak ada alamat publik, ada risiko ToS GitHub, ada jeda tiap pindah "kamar"). Cocok untuk tahap belajar/eksperimen; untuk produksi serius → jalur **VPS murah** (mode `host_mode: vps` sudah didesain di panel).

**Yang pemilik butuhkan dari AI berikutnya:** buat ALUR UMUM yang bisa dipakai ulang untuk project APA PUN ("pola standar deploy project baru"), bukan solusi sekali-pakai untuk satu bot.

## 3. STATUS PROJECT PER 6 SEPTEMBER 2026 (TERVERIFIKASI NYATA)

### Yang sudah jalan (diverifikasi langsung di sesi ini)
- ✅ **Sistem LIVE di laptop pemilik**: manager di `127.0.0.1:8097`, panel di `127.0.0.1:8080`, `runtime/sockets/cli-token` ada, 9 database SQLite di `data/`.
- ✅ **Test suite hijau**: ±456 unit test + 11 recovery test lulus (dijalankan `npm test` di sesi ini, 0 error; output shell terpotong timeout tapi tidak ada kegagalan).
- ✅ F1–F5 selesai di level modul (lihat docs/ARCHITECTURE.md, docs/DESIGN.md).
- ✅ Deploy pipeline teruji end-to-end: node, python, static, termasuk deploy dari git sungguhan.
- ⚠️ **9router TERDAFTAR di `projects.auto.json`** (type: node, port: 20127, repo: `github.com/decolua/9router`, branch: `main`, enabled: true) — tapi statusnya **UJI COBA, BUKAN KOMITMEN**. Pemilik menyatakan: "9router belum terdaftar 100%, masih coba-coba". BELUM pernah di-deploy. Jangan anggap ini roadmap tetap.
- ✅ 9Router lokal pemilik sedang jalan di **port 20128** (dilihat dari daftar proses). Ini aplikasi pihak ketiga milik pemilik, bukan bagian VM-Panel.

### Yang BELUM ada / belum selesai (jangan klaim selesai!)
- ❌ **Brankas (vault) KOSONG** — `secrets/vault.enc` belum ada isinya; `secrets/secrets.yaml` belum ada.
- ❌ **Fitur tunnel = `none`** — TIDAK ada akses publik ke internet. Apapun yang di-host belum bisa dibuka dari HP/luar.
- ❌ Beberapa perintah CLI masih stub (exit 2): `vmctl export/import`, `deployment rollback/retry/logs`, sebagian `project`/`service` (lihat README §status & docs/OPERATIONS.md).
- ❌ `deployment_queue` (tabel antrean di services.db) **sudah ada skemanya tapi belum tersambung** ke worker.
- ❌ Folder `tests/integration/` dan `tests/security/` kosong (isinya menyatu di unit test).
- ❌ Panel tidak real-time (SSR snapshot; tidak ada WebSocket/SSE).
- ⚠️ **PERIKSA INI**: manifest `projects.auto.json` memakai `git_branch: "main"`, tapi repo `decolua/9router` default branch-nya **`master`** (dicek via GitHub di sesi ini). Deploy pertama kemungkinan gagal fetch. Ganti ke `master` atau buat branch `main` sebelum deploy.

## 4. RISET 9ROUTER YANG SUDAH DILAKUKAN (JANGAN ULANGI)

Sumber: README resmi + source code (`src/lib/db/index.js`, `src/app/api/settings/database/route.js`, gitbook `deployment/cloud.md`) — riset via librarian + explorer, September 2026.

- **Fitur Export/Import Database ADA**: Dashboard → Profile → "Export database" → file `9router-backup-<timestamp>.json`. Isi: settings, providerConnections (termasuk token/API key), providerNodes, proxyPools, apiKeys, combos, modelAliases, customModels, mitmAlias, pricing. Import = **wipe & replace** semua tabel.
- **Import bisa PROGRAMMATIK via REST** (tidak harus klik web UI):
  - `GET /api/settings/database` (header `x-9r-password: <password dashboard>`) → dapat snapshot
  - `POST /api/settings/database` (body `{password, ...payload}`) → import penuh
  - Tidak ada CLI/env var/auto-import-on-startup bawaan → **skrip auto-import harus dibuat sendiri**.
- **Penyimpanan lokal 9Router**: `DATA_DIR` (default `~/.9router`; Windows: `%APPDATA%\9router`), state utama = SQLite di `db/data.sqlite`. Deploy headless resmi via env: `JWT_SECRET`, `INITIAL_PASSWORD`, `DATA_DIR`, `PORT=20128`, `HOSTNAME=0.0.0.0`, `NODE_ENV=production`, `API_KEY_SECRET`, `MACHINE_ID_SALT`.
- **Cloud Sync** bawaan (via `https://9router.com`) itu closed-source & sejarahnya ada isu kebocoran token (issue #140, #965) → keputusan: **pakai jalur export-file + REST import** (lebih terkontrol), BUKAN Cloud Sync.
- Login remote 9Router diblokir kalau password masih default (`mustChangePassword`) → headless wajib set `INITIAL_PASSWORD`.

## 5. ARSITEKTUR YANG SUDAH DISEPAKATI UNTUK TUJUAN PEMILIK

```
┌─ Komputer GitHub Actions (kamar hotel, diusir ±6 jam) ──────┐
│  VM-Panel (manager 8097 + panel 8080)                       │
│   ├─ Project #1: bot Telegram A (polling keluar) ✅          │
│   ├─ Project #2: bot Telegram B (polling keluar) ✅          │
│   ├─ Project #N: aplikasi lain...                            │
│   └─ (Opsional) 9Router sebagai "penyedia otak AI" bersama,  │
│        dipakai project yang butuh model — via 127.0.0.1      │
│  Semua bot Telegram: polling KELUAR → tak butuh alamat publik│
└──────────────────────────────────────────────────────────────┘
   Sebelum mati: state dienkripsi → artefak `runtime/vm-state.enc`
   Kamar baru bangkit: unduh → dekripsi → deploy manifest → semua project hidup lagi
```

**Pola umum tiap project baru** (ini yang harus bisa diulang-ulang):
1. Daftarkan repo di manifest (`projects.auto.json`) / lewat panel
2. Secret-nya (token bot, API key) masuk **brankas** dulu — bukan repo
3. Deploy → service running + health OK
4. Kalau butuh config "koper" (seperti 9Router), pakai mekanisme vault + auto-import

**Aturan EMAS (langgar = bocor):** file export 9Router (dan file konfigurasi project lain) berisi API key pemilik.
- 🚫 **DILARANG commit ke repo/git** (apalagi repo publik).
- ✅ Hanya boleh masuk **vault terenkripsi** (`secrets/vault.enc`, kunci `VPANEL_MASTER_KEY` di `.env`) atau GitHub Secrets.
- Selalu ingatkan pemilik soal ini kalau dia minta "taruh aja di repo".

## 6. MASALAH YANG PEMILIK ALAMI SEKARANG (KONTEKS NYATA)

1. **Bingung konsep "deploy ke mana"** — sudah dijelaskan: sekarang panel jalan di LAPTOP sendiri (deploy = install di laptop). Untuk 24/7 tanpa laptop, panel harus pindah ke GitHub Actions (gratis, tapi terbatas) atau VPS (stabil).
2. **Takut 9router lokal "tabrakan" dengan yang di panel** — sudah dijelaskan & diverifikasi: folder beda, port beda (lokal 20128, panel 20127), tidak saling sentuh. Satu-satunya ketergantungan: yang di-deploy = versi di GitHub, jadi **harus push dulu** perubahan terbaru.
3. **Tahap kesepakatan**: pemilik MASIH BELUM MAU produksi — sekarang masih fase tanya-tanya/nyiapin. Jangan tiba-tiba deploy apa pun tanpa diminta.
4. **(PENTING, koreksi dari pemilik)** Pemilik menegaskan tujuannya LEBIH BESAR dari 9router: "TUJUAN SAYA GA SEKECIL ITU, KEDEPANNYA MUNGKIN SAYA AKAN DEPLOY BOT TELEGRAM LAIN ATAU YANG LAINNYA, 9ROUTER BELUM TERDAFTAR 100% MASIH CUMA COBA COBA". Artinya: prioritas AI berikutnya = **membangun ALUR/pola umum deploy project baru yang bisa dipakai untuk project APA PUN**, bukan solusi khusus 9router. 9router = pilot/kelinci percobaan.
5. **Yang belum lengkap untuk tujuan 24/7 multi-project** (pemilik tahu dan setuju):
   - Mekanisme "config koper" umum (file konfigurasi project tersimpan di brankas, di-suntik saat bangkit) → **belum dibuat**; contoh kasus: tombol upload export 9Router
   - Skrip auto-import (service nyala → suntik config dari brankas) → **belum dibuat**
   - Vault masih kosong (belum ada `VPANEL_MASTER_KEY` dipakai untuk apa pun) → fondasi dari SEMUA project ke depan

## 7. PAKET KERJA YANG SUDAH DIBAHAS: "PAKET FONDASI PLATFORM + PILOT 9ROUTER"

Kalau pemilik bilang "mulai" / "kerjakan", ini urutannya. Prinsip: **bangun alur umum dulu, pakai 9router sebagai kelinci percobaan pertama.**

### Fase A — Fondasi platform (berlaku untuk SEMUA project ke depan)
1. **Isi vault pertama kali**: generate `VPANEL_MASTER_KEY`, buat `secrets/secrets.yaml` (refs), provisikan secret pertama. Ini prasyarat semua project.
2. **Mekanisme "config koper" umum**: cara standar menyimpan file konfigurasi sebuah project di vault (terenkripsi) + menyuntikkannya ke service saat startup (env/file mount). Component panel: upload/update file config per project (owner-only, CSRF, pola `panel/server/index.js`).
3. **Skrip startup-hook umum**: setelah service jalan, opsional jalankan "inject config" (contoh: POST ke API 9Router; nanti bisa dipakai project lain juga). Pakai Node bawaan (`fetch`), tanpa dependency baru.
4. **Panduan 1 halaman untuk pemilik** (bahasa awam): "cara tambah project baru dari nol" — daftar → secret ke brankas → deploy → cek hidup; plus cara update config, cara cek bot hidup, tombol darurat.

### Fase B — Pilot: 9Router + bot pertama (uji nyata alur umum)
5. **Perbaiki manifest** `projects.auto.json`: `git_branch` → `master` (repo 9router default-nya `master`). Deploy 9router pertama di laptop sampai `running` + health OK.
6. **Uji config koper**: export database 9Router → simpan ke vault → auto-import saat bangkit → verifikasi combos/provider terisi.
7. **Daftarkan bot pertama** (hermes atau yang pemilik pilih) + atur env (mis. `9ROUTER_URL=http://127.0.0.1:20127/v1`, token Telegram via vault).
8. **Uji siklus penuh**: simulasi kamar hotel mati → bangkit → semua project hidup → health hijau.

Catatan implementasi:
- Satu dependency produksi saja (AGENTS.md §5) → skrip pakai Node bawaan (`fetch`), jangan tambah package.
- Semua module baru wajib punya unit test `node:test` (AGENTS.md §6) dan `npm test` hijau.
- Destructive ops wajib two-phase (AGENTS.md §4).
- Ikuti pola panel yang ada: `panel/server/index.js` (route), `panel/static/panel.js` (confirm dialog), `manager/api-data-routes.js` (endpoint data).

## 8. REKOMENDASI PENGEMBANGAN (URUT PRIORITAS, KONTEKS PEMILIK)

1. **Paket Fondasi Platform** (Fase A, bagian 7) — vault + config koper umum + panduan "tambah project baru". Ini yang bikin platform bisa dipakai untuk project APA PUN.
2. **Pilot 9Router + bot pertama** (Fase B, bagian 7) — bukti alur umumnya jalan, sekalian kasus nyata pertama pemilik.
3. **Selesaikan stub CLI** (`export/import/rollback/retry`) — versi internalnya sudah ada di manager, tinggal sambungkan ke `bin/vmctl.js`.
4. **Sambungkan `deployment_queue`** ke worker pool (skema sudah ada).
5. **Real-time di panel** (minimal polling otomatis status service di dashboard) — pemilik sering ngecek "bot masih hidup gak", dan makin banyak project makin penting.
6. **Jalur VPS**: dokumentasikan pemindahan panel ke VPS (`host_mode: vps`) — jalan keluar resmi kalau GitHub Actions dilarang/kuota habis, dan wajib saat project pemilik sudah serius.
7. **(Opsional, jangan prioritaskan sebelum diminta)** fitur tunnel — TIDAK dibutuhkan untuk bot polling; baru relevan kalau pemilik mau buka dashboard (9Router/panel) dari luar.
8. Jangan lupa: pindahkan folder `tests/integration` & `tests/security` agar sesuai namanya, atau hapus .gitkeep-nya.

## 9. CHECKLIST VERIFIKASI CEPAT UNTUK AI BARU

```powershell
# 1. Service hidup?
Get-NetTCPConnection -LocalPort 8097,8080 -State Listen
# 2. Token manager ada?
Test-Path runtime\sockets\cli-token
# 3. Test hijau?
npm test
# 4. Manifest siap?
Get-Content projects.auto.json
# 5. Vault terisi?
Get-ChildItem secrets\
# 6. 9router lokal pemilik jalan? (harusnya 20128)
Get-NetTCPConnection -State Listen | Where-Object LocalPort -ge 10000
```

Kalau semua merah/kosong → sistem belum dinyalakan: `npm start` (menjalankan manager + panel, tunggu health).

## 10. GAYA KOMUNIKASI DENGAN PEMILIK (RINGKASAN)

- Bahasa Indonesia, bahasa awam, analogi konkret (hotel/rumah/koper/brankas).
- Tunjukkan BUKTI sebelum klaim berhasil (test output, port listening, halaman terbuka).
- Jangan banjir istilah: "self-chain" = "kamar hotel bangkit lagi", "vault" = "brankas", "deploy" = "pasang", "port" = "nomor telepon aplikasi".
- Kapitalisasi berlebih dari pemilik (HURUF BESAR) = emosi/bingung, bukan marah. Balas dengan lebih sederhana, bukan lebih teknis.
- Selalu tutup dengan pilihan langkah berikutnya yang konkret.

---
*Terakhir diperbarui: 2026-09-06, oleh sesi orchestrator (analisis penuh project + riset 9router + kesepakatan Paket 9Router 24/7).*
