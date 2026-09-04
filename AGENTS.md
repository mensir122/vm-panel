# AGENTS.md — Aturan untuk Coding Agent di Repo Ini

Aturan ini **wajib** dipatuhi semua agent yang bekerja di VM-Panel.

> Status implementasi: F1-F5 selesai — lihat docs/ untuk detail operasional.

## 1. Sistem 100% Fresh

Repo ini adalah sistem **100% fresh**. **DILARANG** membaca, menghubungkan, menyalin, atau memakai data, credential, repo, bot, panel, atau DB apa pun dari **luar folder ini**. Tidak ada jejak dari sistem lama yang boleh dibawa masuk.

## 2. Dilarang Hardcode Secret

**DILARANG** hardcode token, password, API key, atau secret apa pun di kode, config, atau env. Secret hanya boleh diakses melalui **secret refs** (`secrets/secrets.yaml`) yang menunjuk ke **vault** terenkripsi (`secrets/vault.enc`).

## 3. Dilarang Menulis Secret ke Artefak Non-Secret

**DILARANG** menulis secret ke log, audit trail, README, frontend, atau artefak non-secret lainnya. Log boleh berisi ID referensi secret, bukan isinya.

## 4. Operasi Destruktif Wajib Two-Phase Confirm

Operasi destruktif (delete, restore-overwrite, rollback, reset, dsb.) **wajib** two-phase: fase 1 membuat token konfirmasi, fase 2 baru mengeksekusi dengan token tersebut. Tanpa konfirmasi eksplisit → tolak.

## 5. Gaya Kode

- Modul **ESM** (`import`/`export`), **Node >= 20**.
- **Satu dependency produksi**: `better-sqlite3`. Tidak boleh menambah dependency lain tanpa persetujuan.

## 6. Unit Test Wajib

Setiap modul **wajib** punya unit test memakai `node:test` bawaan Node. Modul tanpa test = tidak selesai.

## 7. Definisi Selesai

Klaim "selesai" hanya valid jika **`npm test` hijau**. Tidak ada pengecualian.

## 8. Jangan Klaim Service Live Tanpa Verifikasi

**DILARANG** mengklaim service "live/berjalan" tanpa verifikasi nyata (proses hidup, port merespons, health check lolos). Klaim tanpa bukti = tidak sah.
