# SECURITY.md — Model Keamanan

Ringkasan. Sumber lengkap: [DESIGN.md](DESIGN.md) §11 (permission), §12 (threat model), §13 (secret), §14 (audit), §20-21 (keterbatasan).

## 1. Ringkasan threat model (STRIDE, subset utama dari 32 ancaman DESIGN §12.1)

| Ancaman | Vektor | Mitigasi (implementasi nyata) |
|---|---|---|
| Spoofing — panel login | Brute force password/TOTP | Password scrypt (lib/crypto), faktor kedua wajib (TOTP), lockout 5 gagal/15 menit, rate limit login 10/menit/IP, audit semua percobaan |
| Spoofing — session | Cookie theft | Cookie HttpOnly + SameSite=Strict (+Secure di HTTPS), TTL 8 jam, CSRF double-submit (cookie + token terikat session) |
| Spoofing — Manager API | Token abuse | Bearer token via konstanta-waktu compare (sha256 + timingSafeEqual), loopback-only bind, rate limit 60 req/menit, body limit 1MB |
| Tampering — audit | Edit/delete history | SQLite trigger append-only (`no_delete`); purge owner-only dua fase yang meninggalkan event `AUDIT_PURGE` |
| Tampering — backup | Corrupt/tamper archive | sha256 manifest + verifikasi read-back + integrity_check DB; backup gagal tidak pernah menggantikan yang valid |
| Info disclosure — log/audit | Secret bocor | Redaction pipeline (pola token/password/api-key/cookie/private-key/session/otp) + pencocokan nilai secret aktif → `***REDACTED***` |
| Info disclosure — export | Secret terbawa | Export default tanpa secret; nilai hanya ikut pada export terenkripsi (AES-256-GCM + PBKDF2 600k) |
| Info disclosure — API | Secret di response | Panel/API tidak pernah mengembalikan nilai secret (bahkan owner) — hanya metadata ref |
| DoS — API/disk | Flood, backup flood | Rate limit per token/IP, queue cap, retention, rate-limit backup 30 menit, storage monitor |
| Elevation — permission | viewer → aksi operator | Middleware enforce per action + scoping per-project (`project_scopes`) + audit denied |
| Injection — command | start_cmd jahat | Spawn argv array tanpa shell; allow-list; health command juga argv-only |
| Injection — import | Zip/traversal/symlink | Entry validation (no `../`, no absolute, no symlink, whitelist ekstensi), checksum, staging + rollback point |
| Availability — crash-loop | Service mati-mati | Restart limit + backoff eksponensial + state CRASH_LOOP + manual retry |
| Availability — DB corrupt | WAL stale / byte flip | Preflight header + integrity check + REFUSE_START_DB (tanpa auto-delete) + restore pipeline |
| Supply-chain — workflow GHA | Fork PR, secrets exposure | `permissions:` minimal per job; secrets tidak dipass ke fork PR; workflow file dilindungi branch protection |

Trust boundaries (DESIGN §12.2): untrusted = project code, git repo, archive import, panel input; semi-trusted = vmctl token, session user; trusted = manager core, secret store, audit, backup store pasca-verify.

## 2. Secret management (DESIGN §13)

Arsitektur:

```
config.yaml            → konfigurasi biasa (TANPA secret)
secrets/secrets.yaml   → referensi saja: name → project_scope (tanpa nilai)
secrets/vault.enc      → envelope AES-256-GCM: {name, projectScope, ciphertext, iv, tag,
                         createdAt, rotatedAt, expiresAt}
env saat spawn         → SecretManager resolve secret:// refs → child env (tidak di-log)
```

Aturan yang dijalankan kode:

- Master key dari env `VPANEL_MASTER_KEY` (GHA: secret; VPS: keyfile mode 600). Tidak pernah di-commit, tidak pernah masuk log.
- Vault (`lib/vault.js`): kEnc di-derive per-file salt (PBKDF2-SHA256 600k); tamper (GCM tag gagal) → gagal load; write atomik (tmp + rename).
- Scope per-project: secret hanya bisa di-resolve oleh service dari project yang sama.
- Redaction wajib sebelum tulis log/audit/error (`lib/redact.js`): pattern + pencocokan nilai secret aktif.
- Panel/API tidak pernah menampilkan nilai secret — hanya metadata (name, scope, rotated_at, expires_at).
- Rotation: re-encrypt vault + update refs; expiry dicek saat startup → alert.
- Dilarang menulis secret ke log, audit, README, frontend, atau artefak non-secret lainnya (AGENTS.md §3).

## 3. Model kripto (DESIGN §12.3)

| Kebutuhan | Primitif | Parameter |
|---|---|---|
| Password panel | `crypto.scrypt` (Node bawaan) | OWASP params, 64-byte key, salt per user |
| Faktor kedua | TOTP RFC-6238 (HMAC-SHA1) | base32 secret 20 byte, window ±1, `timingSafeEqual` |
| Vault + export terenkripsi | AES-256-GCM | IV acak per enkripsi, tag diverifikasi |
| Derive kunci | PBKDF2-SHA256 | 600.000 iterasi (vault kEnc, export key) |
| Checksum/integritas | SHA-256 | per-file + manifest backup/export |
| Token | random crypto | bearer API, session id, csrf token, recovery code (disimpan sebagai hash) |

## 4. Permission model (DESIGN §11)

- Role: **owner** (semua operasi termasuk restore/rollback/secret metadata/purge/user), **operator** (deploy, lifecycle service, backup manual, lihat audit), **viewer** (baca saja, scoped).
- Enforcement di tiga titik: middleware Manager API per action, gating halaman panel, dan role token vmctl.
- Scoping: `project_scopes` per user — ada row scope → hanya itu yang terlihat; tanpa row → semua sesuai role. Cache 60s, invalidasi saat perubahan permission.
- Login: username + password + TOTP (atau recovery code sekali pakai); lockout 5/15 menit; user baru status inactive sampai owner approve.

## 5. Yang TIDAK dijamin (jujur)

1. **Isolasi project di GitHub Actions = advisory.** Project process berjalan sebagai user OS yang sama dengan manager; project code berusaha keras secara teori bisa membaca file manager. Mitigasi yang ada (env whitelist, path check, argv tanpa shell, resource limits) mempersempit tapi tidak menjadi boundary keamanan asli. Boundary asli hanya di VPS mode (systemd user terpisah per project). **Jangan jalankan project tidak terpercaya di mode GHA.** (DESIGN §12.2, §21.15)
2. **Anti-replay API dipangkas**: bearer + loopback + rate limit dipandang cukup untuk fase ini; tidak ada nonce/replay window.
3. **Uptime tidak dijamin di runner GHA** — self-chain bisa gagal (API limit, incident GitHub); watchdog memitigasi, tidak menjamin.
4. SQLite bukan Postgres-cluster: DB produksi besar sebaiknya tetap di service terkelola.
5. Resource limiting: enforcement penuh hanya di Linux (systemd/cgroup); Windows = fallback advisory dengan audit warning.
6. Registry HMAC signing & fingerprint project DIPANGKAS dari desain (ancamannya = local attacker yang sudah pegang box) — validasi schema + referential check tetap ada.
7. Enkripsi export melindungi data saat transit/at-rest, tetapi kekuatannya bergantung pada password yang dipilih user (PBKDF2 600k memperlambat brute force, tidak menggantikan password kuat).

## 6. Melaporkan masalah keamanan

- **Jangan buka issue publik** untuk kerentanan yang bisa dieksploitasi.
- Laporkan secara privat ke maintainer/pemilik repo (kontak lihat halaman repo). Sertakan: deskripsi, langkah reproduksi, dampak, versi/commit.
- Perbaikan diumumkan lewat changelog repo tanpa membocorkan detail eksploitasi sebelum fix tersedia.
- Laporan soal sistem lama di luar folder ini tidak berlaku — repo ini 100% fresh (lihat README).

## 7. Checklist keamanan operasional harian

- Set `VPANEL_MASTER_KEY` minimal 32 karakter acak; simpan di secret manager/Keyfile 600, bukan shell history.
- Jangan expose port manager (8097) ke luar; panel hanya via reverse proxy + TLS di VPS.
- Pantau `vmctl audit list` untuk login gagal beruntun dan akses denied.
- Simpan recovery codes offline (password manager/cetak), bukan di repo.
- Backup ke storage eksternal untuk state penting (DESIGN §20.1).
