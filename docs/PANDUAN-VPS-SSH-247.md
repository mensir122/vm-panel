# Panduan Lengkap ORIONT Headless VPS 24/7 & Akses SSH Key

Repositori ini telah dirombak 100% menjadi **Headless Linux VPS Engine** di atas GitHub Actions runner dengan kontrol penuh OpenSSH Server port 22, persistensi state terenkripsi, dan operasi terus menerus 24/7 tanpa mati.

---

## 1. Persiapan Awal (Hanya Perlu Dilakukan Sekali)

### Langkah 1: Buat Kunci SSH di Laptop Anda (Jika Belum Ada)
Buka terminal PowerShell atau Terminal Linux/Mac di laptop Anda, lalu jalankan:
```bash
ssh-keygen -t ed25519 -C "vpanel-vps"
```
Tekan Enter untuk lokasi default (`~/.ssh/id_ed25519`). Kunci privat Anda akan berada di `~/.ssh/id_ed25519` dan kunci publik Anda berada di `~/.ssh/id_ed25519.pub`.

Salin isi kunci publik Anda:
- Di Windows (PowerShell):
  ```powershell
  Get-Content ~\.ssh\id_ed25519.pub | Set-Clipboard
  ```
- Di Linux / Mac:
  ```bash
  cat ~/.ssh/id_ed25519.pub
  ```

---

### Langkah 2: Daftarkan Secret di GitHub Repository
Buka repositori GitHub Anda di browser:
1. Masuk ke **Settings** → **Secrets and variables** → **Actions**.
2. Klik **New repository secret**, tambahkan:
   - **`SSH_PUBLIC_KEY`**: Tempel isi kunci publik Anda (misal `ssh-ed25519 AAAAC3...`).
   - **`VPANEL_MASTER_KEY`**: Masukkan kunci rahasia minimal 32 karakter untuk enkripsi state cloud (AES-256-GCM).

#### Pilihan Koneksi Jaringan (Pilih Salah Satu):
- **Opsi A: Tailscale (Sangat Direkomendasikan & Paling Nyaman)**:
  1. Buat akun gratis di [tailscale.com](https://tailscale.com).
  2. Install aplikasi Tailscale di laptop Anda dan login.
  3. Buka Tailscale Admin Console → **Settings** → **Keys** → Buat **Auth Key** (centang *Ephemeral* dan *Reusable*).
  4. Masukkan auth key tersebut ke GitHub Secret dengan nama:
     **`TAILSCALE_AUTHKEY`**
  5. *Hasil*: Runner akan selalu mendapatkan nama host tetap `vpanel-vps` di Tailnet Anda!
- **Opsi B: Fallback Tmate (Tanpa Akun Apapun)**:
  - Jika Anda tidak mengisi secret tunnel, runner akan otomatis membuat sesi Tmate dan mencetak perintah SSH di log GitHub Actions.

---

## 2. Cara Menjalankan VPS 24/7

1. Masuk ke tab **Actions** di repo GitHub Anda.
2. Klik workflow **vm** di panel sebelah kiri.
3. Klik dropdown **Run workflow** → pilih branch `main` → klik tombol hijau **Run workflow**.

Runner akan langsung boot, mendekripsi state data terakhir, menyalakan OpenSSH Server, menghubungkan tunnel Tailscale, dan masuk ke loop penjaga 24/7.

---

## 3. Cara Terhubung ke VPS via SSH

### Jika Menggunakan Tailscale:
Cukup jalankan perintah berikut dari PowerShell / Terminal laptop Anda:
```bash
ssh runner@vpanel-vps
```
Atau menggunakan user `root` (bila memerlukan akses root langsung):
```bash
ssh root@vpanel-vps
```

### Jika Menggunakan IP Tailscale:
```bash
ssh runner@100.x.y.z
```

---

## 4. Perintah & Pengelolaan di Dalam VPS

Begitu Anda masuk ke dalam VPS, Anda memiliki akses `sudo` penuh tanpa password!

### Menggunakan `vmctl` (ORIONT CLI):
Perkakas CLI `vmctl` sudah terpasang global di sistem (`/usr/local/bin/vmctl`):
```bash
# Cek status sistem & runtime
vmctl system status

# Cek daftar project yang berjalan
vmctl project list

# Cek log project
vmctl project logs <id>

# Kelola service
vmctl service list
vmctl service restart <id>

# Cek status audit log
vmctl audit list
```

### Menginstal Aplikasi atau Package Tambahan:
Anda bebas menginstal software Linux apa saja:
```bash
sudo apt update
sudo apt install -y htop git curl wget python3 python3-pip
```

---

## 5. Menjaga Sesi Terminal dengan `tmux`

Karena runner GitHub Actions memiliki siklus pergantian perangkat keras otomatis setiap 6 jam (self-chaining):
1. Runner akan memberikan notifikasi hitung mundur terminal:
   ```
   ⚠️ [ORIONT VPS] Siklus 6 jam akan berpindah dalam 15 menit. State sedang disinkronkan ke cloud...
   ```
2. Anda disarankan menjalankan pekerjaan panjang di dalam `tmux`:
   ```bash
   tmux new -s kerjaan
   ```
3. Jika koneksi SSH Anda terputus saat handoff 6 jam (jeda ~45 detik), cukup sambungkan kembali:
   ```bash
   ssh runner@vpanel-vps
   tmux attach -t kerjaan
   ```

---

## 6. Arsitektur Keamanan & Enkripsi
- **Tanpa Password**: Autentikasi password dinonaktifkan (`PasswordAuthentication no`). Hanya Anda yang memegang private key yang bisa login.
- **Enkripsi AES-256-GCM**: Semua data SQLite dan file workspace disimpan terenkripsi ke branch `state` saat runner berpindah, sehingga tidak ada data yang bocor di repositori publik.
- **Watchdog Eksternal (`recovery.yml`)**: Berjalan otomatis setiap 15 menit untuk membangkitkan runner jika terjadi gangguan jaringan pada server GitHub.
