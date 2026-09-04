# DATA-GUIDE — Panduan Data untuk Pemula

Panduan ini menjelaskan cara mengambil, menyimpan, dan mengembalikan data
VM-Panel Anda — ditulis untuk yang **tidak paham coding**, langkah demi langkah.

---

## 1. Data Anda itu apa saja dan di mana?

| Data | Isinya | Di mana disimpan |
|---|---|---|
| Database (projects, users, audit, dst.) | Semua project, akun, catatan aktivitas | Terenkripsi di artifact **vm-state** (GitHub Actions) |
| Kunci pembuka (`VPANEL_MASTER_KEY`) | "Kunci brankas" data Anda | File `.env` di komputer Anda + GitHub Secrets |
| Kode program | VM-Panel itu sendiri | Repo ini (terbuka, bukan data rahasia) |

**Yang penting dipahami:** file `vm-state.enc` di GitHub itu TERENKRIPSI.
Orang lain bisa mengunduhnya, tapi isinya hanya bisa dibaca oleh kunci Anda.

---

## 2. Cara MENGAMBIL data Anda kapan pun (3 menit)

1. Buka repo Anda di browser: `github.com/mensir122/vm-panel`
2. Klik tab **Actions**
3. Klik run paling atas (yang hijau) → scroll ke bawah halaman run itu
4. Di bagian **Artifacts**, klik **vm-state** → file `.enc` terunduh
5. Simpan file itu di tempat aman (flashdisk / Google Drive pribadi)

Atau lewat terminal (jika sudah `gh auth login`):
```
bash scripts/export_state.sh
```

**Saran rutin:** unduh 1x seminggu. Cukup simpan file `.enc` terbaru.

---

## 3. Cara MENGEMBALIKAN data (komputer baru / setelah bencana)

Prasyarat: komputer baru sudah ter-install Node.js, VM-Panel sudah di-download
(clone atau download ZIP dari repo ini), dan **file `.env` berisi
`VPANEL_MASTER_KEY` yang SAMA** dengan dulu.

1. Pastikan manager & panel **tidak sedang berjalan**.
2. Letakkan file `.enc` hasil unduhan di folder repo.
3. Buka terminal di folder repo, jalankan:
```
bash scripts/import_state.sh <nama-file>.enc "PASTE-VPANEL_MASTER_KEY-ANDA"
```
   (kunci ada di file `.env` Anda — baris VPANEL_MASTER_KEY)
4. Jalankan VM-Panel seperti biasa (`npm start` + `npm run start:panel`).
   Semua project, akun, dan catatan akan kembali seperti saat backup dibuat.

Skrip ini **tidak pernah menghapus data lama** — backup lama otomatis
disimpan sebagai "rollback point" kalau hasilnya tidak cocok.

---

## 4. Skenario terburuk — apa yang terjadi dan apakah Anda aman?

| Skenario | Data Anda | Yang harus dilakukan |
|---|---|---|
| Repo di-suspend / terhapus | ✅ Aman | Sudah punya file `.enc` lokal (bagian 2) + `.env`. Import ke VM-Panel baru (bagian 3) |
| Lupa unduh artifact (kedaluwarsa 30 hari) | ⚠️ Boleh jadi hilang | Rutin unduh mingguan (bagian 2). Chain baru juga selalu membuat backup baru |
| `.env` hilang | ⚠️ Data tidak bisa dibuka | Kunci TIDAK bisa dipulihkan oleh siapa pun (termasuk GitHub) — simpan kunci di 2 tempat aman |
| Kunci bocor ke orang lain | ⚠️ Mereka bisa baca backup Anda | Buat kunci baru, ganti di GitHub Secrets + `.env`, data lama tetap aman selama kunci lama tak dipakai orang |
| Ada yang merusak file .enc | ✅ Aman | Enkripsi punya tamper-check: file rusak langsung ditolak, backup lain masih valid |
| GitHub error total | ✅ Aman | Data = file `.enc` yang Anda unduh + kunci di `.env` — keduanya milik Anda, bukan milik GitHub |

**Kesimpulan:** keamanan data Anda = **file `.enc` (rutin diunduh)** +
**kunci di `.env` (disimpan di 2 tempat aman)**. Keduanya milik Anda,
tidak bergantung pada GitHub.

---

## 5. Yang PUBLIK di repo ini (transparansi)

Yang terbuka untuk umum: **kode program** dan **log ringkas** (tanpa kunci,
tanpa isi database). Yang TIDAK pernah ikut repo: database Anda, kunci Anda,
file `.env` (semua terenkripsi/ter-gitignore, ada tamper-check).

- Kode berisi 0 kredensial (ada test otomatis yang menolak commit berisi kunci)
- Semua backup di-upload dalam keadaan TERENKRIPSI (lihat §9.5 DESIGN.md)
- Kalau ada yang mencoba merusak file `.enc` → sistem menolaknya otomatis

---

## 6. Satu hal yang TIDAK bisa dilindungi siapa pun

Kunci `VPANEL_MASTER_KEY` di `.env` Anda: **siapa pun yang punya file itu +
file `.enc` bisa membuka data Anda.** Jangan pernah:
- Commit `.env` ke git (sudah dicegah otomatis)
- Kirim kunci lewat chat/email
- Simpan kunci di tempat yang bisa diakses orang lain

Simpan kunci seperti Anda menyimpan password bank.
