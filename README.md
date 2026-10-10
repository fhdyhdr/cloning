# Site Weaver

Bangun aplikasi "Site Cloner" — web tool untuk meng-clone website lain menjadi

project kode production-ready. Tanpa AI, murni server-side fetch + rewrite.

== ALUR APLIKASI ==

Input URL → klik Clone → tampilkan PREVIEW hasil clone di dalam app (iframe

internal hanya sebagai alat preview/pemilih elemen).

Preview harus PERSIS seperti situs asli termasuk SEMUA animasi (GSAP,

ScrollTrigger, Lenis, Framer Motion, Swiper, Three.js/WebGL, marquee, hover,

scroll-reveal, parallax) dan responsive behavior.

User bisa menandai satu ELEMENT atau SECTION di preview (klik elemen dengan

outline highlight), atau download full site.

Tombol Download ZIP menyediakan 3 target: Static HTML, Vite (React), Next.js.

Jika ada elemen/section terpilih, ZIP berisi potongan itu saja.

== ATURAN KERAS HASIL ZIP (berlaku untuk full maupun selected section) ==

DILARANG: iframe wrapper, screenshot, DOM dump mentah, CSS dump mentah, kode

minified, satu file besar berisi semuanya.

WAJIB — Static target:

project/

├── index.html ← markup semantic saja, tanpa style/script inline besar

├── css/global.css, header.css, hero.css, sections.css, footer.css (terpisah per bagian)

├── js/main.js, animation.js, scroll.js, interaction.js (terpisah per fungsi)

└── assets/images/, videos/, audio/, fonts/, icons/

WAJIB — struktur DOM semantic dengan class deskriptif:

body > header + main(section.hero, section.about, section.gallery,

section.projects, section.contact) + footer

RENAME semua class hasil ekstraksi (.framer-eSUjv, .css-1abc2, dsb) menjadi

nama bermakna: .hero-content, .gallery-wrapper, .project-card, .footer-nav.

CSS WAJIB pretty-formatted multi-baris (satu properti per baris), dipisah

per section, gunakan :root { --color-primary: ... } variables yang jelas.

JavaScript pretty-formatted & readable. Jika situs memakai GSAP/ScrollTrigger/

Lenis dll, hasilnya TETAP memakai library tersebut (bundle lokal di js/vendor/

atau import package), bukan pengganti statis.

SEMUA asset didownload penuh ke ZIP (video & audio tanpa batas ukuran) dan

direferensikan lokal: src="./assets/videos/hero.mp4" — bukan URL situs asli.

Responsive behavior (media query / breakpoint) harus tetap berfungsi.

WAJIB — Vite/React target:

src/components/{Navbar,Footer,...}, src/sections/{Hero,About,Gallery,...}

(satu komponen per section), src/ui/, src/hooks/, src/utils/, src/styles/,

App.tsx hanya menyusun komponen, public/assets/...

TypeScript. Contoh App.tsx: return (<><Navbar/><Hero/>...</>)

WAJIB — Next.js target (App Router):

app/layout.tsx, app/page.tsx (hanya menyusun section), app/globals.css,

app/components/, app/sections/, app/ui/, app/hooks/, app/utils/, public/assets/...

== STRATEGI TEKNIS ==

Server-side: fetch HTML sumber, download semua asset, simpan stylesheet.

Rekonstruksi DOM: bangun ulang tree secara semantic (jangan salin mentah),

audit visual computed-style sebelum/sesudah rename class agar layout tidak

bergeser; rollback jika berubah.

Animasi: jalankan library asli situs pada DOM hasil rekonstruksi; untuk

animasi JS-driven yang tidak bisa dipindahkan, rekam keyframes-nya dan

emit sebagai animasi asli (GSAP timeline / CSS scroll-timeline view()).

Rakit ZIP di server (asset besar), browser cukup menerima file jadi.

Tampilkan progress per fase: fetching → downloading assets → rebuilding → zipping.

Prioritas kualitas: hasil ZIP harus readable, editable, maintainable, dan

production-ready seperti kode buatan developer manual.

warning !!!

saya sebelumnya generate persis seperti prompt diatas di lovable dan sudah jadi, tapi ada masalah dibawah ini

saat export atau download zip ada error ( Failed to fetch )

untuk hasil clone webnya belum sesuai dengan web yang asli (di beberapa section hasil web clone ada element web yang hilang, atau tidak ikut terclone. lalu animasi seperti gsap,framer dll tidak ada)

coba clone web https://shinta.framer.media pastikan preview hasil clone yang ditampilkan di web clone sama seperti hasil zip saat di running

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/15ffc5ba-741e-481f-addd-ecfd48d0ecc1).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
