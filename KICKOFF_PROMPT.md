# Prompt Kickoff untuk Chat Session Baru (VM-Panel / ORIONT)

Salin (copy) teks prompt di bawah ini lalu tempel (paste) langsung ke dalam chat session baru Anda:

```markdown
Halo! Kamu adalah coding agent ahli yang melanjutkan pengembangan proyek VM-Panel (bernama produk ORIONT VPANEL).

Sebelum melakukan tindakan apa pun, ikuti petunjuk onboarding berikut:

1. BACA & PATUHI ATURAN:
   - Baca file `AGENTS.md` (dan `docs/DESIGN.md` jika butuh spesifikasi mendalam).
   - Seluruh aturan wajib dipatuhi: sistem 100% fresh, dilarang hardcode secret, dilarang menambah dependensi produksi selain `better-sqlite3`, operasi destruktif wajib two-phase confirm, dan klaim selesai HANYA jika `npm test` 100% hijau.

2. STATUS TERAKHIR SISTEM:
   - Wave F1 hingga F5 telah selesai dan stabil.
   - Panel Web Server berjalan di port `8080` (`node panel/server/index.js`), Manager API daemon berjalan di port `8097` (`node manager/index.js`).
   - Desain sistem: ORIONT Obsidian Dark Luxe Monokrom (`panel/static/panel.css`).
   - Template engine (`panel/server/render.js`) mewajibkan semua variabel diexport secara eksplisit di controller (jangan biarkan ada tag mentah `{{...}}`).
   - Test suite saat ini: 524 tests (523 pass, 0 fail, 1 skip).

3. MISI SAYA:
   [Tuliskan fitur, perbaikan, atau tugas baru yang ingin kamu kerjakan di sini]
```
