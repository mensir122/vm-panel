# Panduan Praktis: Menambah Bot atau Proyek Baru di VM-Panel

Panduan ini ditulis dengan bahasa sederhana untuk memandu Anda mendaftarkan, mengamankan, dan menjalankan aplikasi apa pun (Bot Telegram, 9Router, Web, dll.) di VM-Panel.

---

## 1. Menyalakan Sistem & Masuk ke Panel

1. Buka terminal (layar hitam PowerShell) di folder VM-Panel, lalu ketik:
   ```bash
   npm start
   ```
2. Tunggu sampai muncul pesan:
   `[start-all] SEMUANYA MENYALA -> buka http://127.0.0.1:8080`
3. Buka browser Anda (Chrome/Edge) dan ketik alamat:
   👉 **`http://127.0.0.1:8080`**
4. Masuk dengan username, password, dan 6 digit kode dari aplikasi Authenticator di HP Anda.

---

## 2. Pola 5 Langkah Tambah Proyek Baru (Standar untuk Proyek Apa Pun)

```
[1. Buat Proyek] ──► [2. Isi Brankas] ──► [3. Pasang Koper Config] ──► [4. Klik Deploy] ──► [5. Cek Lampu Hijau]
```

### Langkah 1: Buat Kamar Proyek Baru
1. Di menu atas panel, klik menu **Projects**.
2. Klik tombol **New project**.
3. Isi data kamar baru:
   - **Nama:** huruf kecil tanpa spasi (contoh: `bot-telegram-saya`).
   - **Tipe:** 
     - Pilih **Node** (untuk bot JavaScript/TypeScript atau aplikasi Next.js).
     - Pilih **Python** (untuk bot Python).
     - Pilih **Static** (untuk file HTML/web biasa).
   - **Port (Nomor Saluran):** Masukkan angka antara `10000` s/d `65000` (contoh: `21001`).
   - **Git URL (Opsional):** Jika kodenya ada di GitHub, masukkan link repo (contoh: `https://github.com/username/repo-bot`).
   - **Branch:** Masukkan nama cabang (biasanya `main` atau `master`).
4. Klik **Create project**. Anda akan langsung dibawa ke halaman detail proyek tersebut.

---

### Langkah 2: Amankan Token / Kunci di "Brankas" (Secrets)
> 🔒 **Aturan Emas:** Jangan pernah menaruh token bot atau API key di dalam kode Git publik. Simpan selalu di brankas!

1. Pada halaman detail proyek, klik tab **Config & Brankas**.
2. Di kartu paling atas (**Brankas**):
   - Jika status masih *"Brankas belum diinisialisasi"*, klik tombol biru **Nyalakan Brankas**.
   - Status akan berubah menjadi *"Brankas aktif"*.
3. Di kartu ketiga (**Variabel rahasia**):
   - **Nama Variabel:** Ketik nama variabel yang diminta bot (contoh: `TELEGRAM_BOT_TOKEN`).
   - **Pilih Rahasia:** Pilih atau ketik nama rahasia yang tersimpan di brankas.
   - Klik **Pasang variabel**.

---

### Langkah 3: Bawa "Koper Konfigurasi" (Jika Ada File Settingan)
Beberapa aplikasi (seperti 9Router atau bot dengan file database JSON) membutuhkan file settingan awal agar tidak mulai dari nol.

1. Masih di tab **Config & Brankas**, lihat kartu kedua (**Config koper**).
2. Klik tombol **Pilih File** (misalnya file `config.json` atau file export settingan).
3. Klik **Unggah ke koper**.
4. File Anda otomatis dienkripsi dan disimpan aman. Saat kamar hotel atau laptop berpindah, file ini akan selalu ikut terbawa!

---

### Langkah 4: Pasang & Jalankan (Klik Deploy)
1. Kembali ke tab **Overview** pada halaman proyek Anda.
2. Klik tombol hijau **Deploy**.
3. Sistem akan otomatis:
   - Mengambil kode terbaru dari GitHub / folder proyek.
   - Menyiapkan dependensi (`npm install` atau virtualenv Python).
   - Menjalankan bot Anda di latar belakang.
   - Menyuntikkan token dari brankas secara aman tanpa bocor ke log.

---

### Langkah 5: Memeriksa Kesehatan Bot (Lampu Indikator)
Masuk ke menu **Services** atau tab **Health**:
- 🟢 **Titik Hijau (Healthy):** Bot hidup normal dan merespons dengan baik!
- 🟡 **Titik Kuning (Degraded):** Bot hidup tetapi ada peringatan (misal memori hampir penuh).
- 🔴 **Titik Merah (Unhealthy / Crash-loop):** Bot mati atau gagal start.
  - Jika merah, buka tab **Logs** untuk membaca pesan kesalahannya (misalnya salah token atau port bentrok).

---

## 3. Tombol Darurat & Operasional Cepat

| Kebutuhan | Tempat / Cara |
|---|---|
| **Bot macet / hang** | Masuk ke tab Overview/Services → klik tombol **Restart**. |
| **Matikan bot sementara** | Klik tombol **Stop**. |
| **Menghapus proyek** | Tab Settings → Hapus project. *(Sistem akan meminta Anda mengetikkan nama proyek untuk mencegah salah klik)*. |
| **Mematikan Panel di Laptop** | Buka terminal tempat Anda menjalankan `npm start`, lalu tekan tombol **Ctrl + C**. |

---
*Dokumen ini dibuat otomatis oleh VM-Panel Assistant — 9 September 2026.*
