# Site Cloner — Fidelity-first

## Tujuan

Membangun tool di `/` untuk mengambil situs publik, menampilkan hasil clone yang benar-benar berasal dari artefak hasil pemrosesan, memilih elemen/section, dan mengunduh ZIP Static, Vite React, atau Next.js. Situs validasi utama: `https://shinta.framer.media`.

## Prinsip utama

- **Preview = isi ZIP**: preview tidak memuat URL sumber. Preview dilayani dari snapshot/artefak clone yang sama dengan yang dipakai exporter.
- **Fidelity lebih utama daripada rename agresif**: class/runtime internal yang dibutuhkan Framer atau animasi dipertahankan ketika perubahan menyebabkan visual atau gerak rusak. Class semantic ditambahkan sebagai alias dan hanya diganti setelah lolos audit.
- Tidak memakai AI, screenshot sebagai hasil, iframe wrapper di ZIP, atau DOM/CSS dump satu-file.
- Hanya situs publik yang mengizinkan fetch yang dapat diproses; proteksi bot, autentikasi, DRM, dan lisensi aset tetap dihormati.

## Implementasi

### 1. UI aplikasi

- Buat workspace desktop responsif dengan input URL, tombol Clone, status fase, panel preview, mode pilih elemen, breadcrumb selection, target export, dan Download ZIP.
- Tambahkan state kosong, proses, sukses, dan error yang menjelaskan kegagalan fetch/export secara spesifik.
- Preview memakai iframe internal yang menunjuk ke endpoint artefak clone, dengan script selector hanya di preview; selector tidak masuk ZIP.

### 2. Pipeline clone server-side

- Validasi URL dan blokir localhost, private IP, metadata endpoints, serta redirect ke jaringan privat (SSRF protection).
- Fetch HTML dengan redirect terbatas, parse dokumen, pertahankan urutan script/style, base URL, metadata, dan responsive markup.
- Temukan dan unduh asset dari HTML, CSS `url()`, `srcset`, preload, poster, font, audio, video, module imports, serta manifest; deduplikasi dan simpan dengan nama stabil.
- Rewrite seluruh referensi ke path lokal dan berikan laporan asset gagal tanpa menghapus elemen pemakainya.
- Untuk Shinta/Framer, pertahankan bootstrap/runtime Framer dan data hydration yang dibutuhkan; lokal-kan resource yang aman dan biarkan fallback runtime eksplisit bila resource tak dapat dipaketkan secara legal/teknis.

### 3. Rekonstruksi dan fidelity guard

- Tambahkan landmark semantic (`header`, `main`, `section`, `footer`) serta class alias deskriptif berdasarkan role/konten.
- Pisahkan CSS menjadi global/header/hero/sections/footer dan JS menjadi main/animation/scroll/interaction/vendor hanya jika dependency/order tetap valid.
- Hindari mengubah class generated yang masih direferensikan CSS/JS. Rename penuh hanya dilakukan pada rule yang dapat dipetakan aman.
- Catat computed-style dan bounding boxes elemen penting pada preview sumber dan clone; tandai deviasi serta rollback transform yang menggeser layout.

### 4. Preview dan pemilih elemen

- Layani file clone melalui route preview dengan path asset relatif yang sama seperti struktur ZIP.
- Inject overlay selector hanya saat preview: hover outline, click-to-select, kirim selector/path semantic ke parent, dan cegah navigasi ketika mode pilih aktif.
- Export section menyertakan ancestor styles, keyframes, font, dependency JS, dan asset transitif yang dibutuhkan section tersebut.

### 5. Export ZIP tanpa `Failed to fetch`

- Buat route download server yang menghasilkan ZIP sebagai response streaming, bukan JSON/base64 dan bukan rakitan browser.
- Tambahkan timeout/error propagation, nama file aman, header `Content-Type`, `Content-Disposition`, dan progress berbasis fase job.
- Static: struktur folder CSS/JS/assets terpisah dan HTML semantic.
- Vite React: TypeScript, section/component terpisah, styles/hooks/utils, public assets, App hanya composition.
- Next.js App Router: layout/page composition, components/sections/ui/hooks/utils, globals, public assets.
- Target React/Next membungkus runtime imperatif dengan lifecycle-safe loader tanpa menghilangkan animasi asli.

### 6. Validasi Shinta

- Clone homepage Shinta dan bandingkan desktop + mobile: hero, marquee, project cards, services, media, footer, hover, scroll/reveal, dan navigation.
- Jalankan preview hasil clone, export ketiga target, buka masing-masing hasil, lalu bandingkan screenshot/layout dan cek console/network untuk asset 404 atau runtime error.
- Verifikasi pemilihan satu section menghasilkan project mandiri yang tetap tampil dan bergerak konsisten.

## Catatan teknis

- Runtime server tidak menyediakan Chromium/headless browser produksi. Capture computed-style penuh dan perekaman animasi generik tidak dapat dijamin hanya dengan `fetch`; fidelity untuk Framer dicapai dengan mempertahankan runtime/hydration aslinya dan rewrite asset konservatif.
- “Tanpa batas ukuran” tidak bisa dijamin oleh serverless hosting. Implementasi memakai streaming dan pesan batas platform yang jelas agar kegagalan tidak lagi tampil sebagai `Failed to fetch` tanpa sebab.
- Hasil clone harus digunakan hanya untuk situs/aset yang pengguna berhak salin.
