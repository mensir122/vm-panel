# Panduan Lengkap ORIONT Headless VPS 24/7 & Akses SSH Key

Repositori ini telah dirombak 100% menjadi **Headless Linux VPS Engine** di atas GitHub Actions runner dengan kontrol penuh OpenSSH Server port 22, persistensi state terenkripsi AES-256-GCM, dan operasi terus menerus 24/7 tanpa mati.

---

## 1. Akses Cepat: 100% Zero-Install (Cukup Pakai PowerShell)

Anda **TIDAK PERLU** menginstal aplikasi tambahan apa pun di laptop Anda (tanpa Tailscale, tanpa software pihak ketiga).

### Cara Terhubung ke VPS:
Cukup buka terminal di folder project ini, lalu jalankan:
```powershell
npm run ssh
```
Perintah ini akan secara otomatis:
1. Memeriksa status runner GitHub Actions (dan memicunya jika belum aktif).
2. Menarik token koneksi terenkripsi dari cloud menggunakan `VPANEL_MASTER_KEY` Anda.
3. Membuka terminal Linux Ubuntu interaktif langsung via OpenSSH native Windows menggunakan kunci privat `~/.ssh/id_ed25519`.

---

## 2. Pilihan Koneksi Cadangan / Alternatif

### Opsi B: Tailscale Mesh VPN (Opsional)
Jika Anda ingin memiliki IP privat tetap (`100.x.y.z`) atau hostname tetap `vpanel-vps`:
1. Buat auth key di [tailscale.com](https://tailscale.com).
2. Simpan di GitHub Secrets dengan nama `TAILSCALE_AUTHKEY`.
3. Anda bisa langsung SSH dengan: `ssh runner@vpanel-vps`.

---

## 3. Perintah & Pengelolaan di Dalam VPS

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

### Menginstal Software Bebas:
Anda bebas menginstal package Linux apa pun:
```bash
sudo apt update
sudo apt install -y htop git curl wget python3 python3-pip
```

---

## 4. Menjaga Sesi Terminal dengan `tmux`

Karena runner GitHub Actions memiliki siklus pergantian perangkat keras otomatis setiap 6 jam (self-chaining):
1. Runner akan memberikan notifikasi hitung mundur terminal sebelum pergantian runner.
2. Anda disarankan menjalankan pekerjaan panjang di dalam `tmux`:
   ```bash
   tmux new -s kerjaan
   ```
3. Jika sesi terputus saat handoff runner (jeda ~45 detik), cukup jalankan kembali:
   ```powershell
   npm run ssh
   ```
   Lalu sambungkan kembali tmux:
   ```bash
   tmux attach -t kerjaan
   ```

---

## 5. Arsitektur Keamanan Zero-Trust
- **Tanpa Password**: Autentikasi password dinonaktifkan (`PasswordAuthentication no`). Hanya Anda yang memegang private key `id_ed25519` yang bisa login.
- **Enkripsi AES-256-GCM**: Semua data SQLite dan file workspace disimpan terenkripsi ke branch `state` saat runner berpindah, sehingga tidak ada data yang bocor di repositori publik.
- **Tmate Key-Enforced (`-a authorized_keys`)**: Sesi tunnel mewajibkan pencocokan kunci publik. Pihak ketiga yang mengetahui alamat host tunnel tetap ditolak total oleh SSH daemon.
- **Watchdog Eksternal (`recovery.yml`)**: Berjalan otomatis setiap 15 menit untuk membangkitkan runner jika terjadi gangguan jaringan pada server GitHub.
