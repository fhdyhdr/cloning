# Site Weaver (Site Cloner) — Architecture & Project Overview

> Single source of truth for onboarding. This file supersedes the older
> `COMPLETE_SUMMARY.md`, `COMPLETION_REPORT.md`, `FINAL_STATUS.md`, `BUG_FIXES.md`,
> `REFACTOR_SUMMARY.md`, `TESTING_GUIDE.md`, `LIVE_SERVER_OPTIMIZATION.md`,
> `FRAMEWORK_*.md`, `STYLE_FIX.md`, and `erere.md` (all deleted — their content is
> consolidated here). Keep this doc up to date as the code evolves.

## 1. What this project is

A web application that **clones any public website into a production-ready,
manually-editable codebase** — Static HTML, Vite (React), or Next.js (App Router).
It is **not** an AI re-builder: the clone is produced purely by **server-side
`fetch` + DOM rewriting + asset bundling** on the Node server. It mirrors the
original site's markup, styles, scripts, and animations so the exported project
reads and edits like code written by hand.

- Validation site / reference target: `https://shinta.framer.media` (a Framer SSR site).
- No AI, no screenshots-as-result, no iframe wrapper inside the ZIP, no monolithic
  DOM/CSS dumps, no minified one-file blobs.
- Only public sites that allow fetching can be cloned. Bot protection,
  authentication, DRM, and asset licensing are respected — clone only sites you
  have the right to copy.

## 2. Quick start

```bash
npm install        # or `bun install` (bun.lock present)
npm run dev        # TanStack Start dev server (Vite)
```

- UI runs at the default Vite dev port; enter a URL → **Clone** → preview →
  **Download ZIP**.
- Lint: `npm run lint`. Format: `npm run format`. Typecheck: `npx tsc -p tsconfig.json`.
- No test suite exists yet (see Roadmap).

## 3. Capabilities

- Clone arbitrary public HTML sites, including SSR/full-page-mounting frameworks
  (Framer, Nuxt, Webflow-style, generic). Framework awareness is heuristic:
  hydrate markers (`data-framer-*`, `#__nuxt`, `window.__NUXT__`) toggle a
  *preserve-runtime/fidelity* path vs a *clean re-render* path.
- Three export targets, all assembled server-side into a ZIP (via `fflate`):
  **Static HTML**, **Vite (React)**, **Next.js (App Router)**.
- Faithful preview rendered from the **same clone artifacts** used by the ZIP
  (not the live URL), with an in-app element/section selector overlay.
- "Download section only" mode: when a user selects an element/section, the ZIP
  contains just that section plus its transitive assets/styles/scripts.
- Full asset download & localization: images, videos, audio, fonts, icons, data,
  manifest, module imports; all references rewritten to local paths.
- Runtime/behavior preservation: the original site's JS bundle is shipped under
  `public/js/` (or `js/`) and attached after the React app mounts, so GSAP,
  ScrollTrigger, Lenis, Framer Motion, Swiper, marquee, scroll-reveal, parallax,
  hover, and responsive behavior keep working.
- Nuxt-specific fidelity: SSR payload kept, text edits re-applied after hydration
  (MutationObserver + path-based re-location), Vue fragment-comment anchors
  restored before the archived runtime bootstraps.

## 4. Tech stack (this app)

- **Runtime**: Node (built for Node 20+), TanStack Start, React 18, Vite, React Router
  file-based routing.
- **Serverless-ready** SSR build via Nitro (`.output/` is produced by `vite build`).
- **ZIP**: `fflate`. **HTML parsing**: `node-html-parser`. **Banking-grade stuff**:
  shadcn/ui + Radix primitives under `src/components/ui/`.
- **Note**: `vite` in generated **Vite exports is pinned to `^4.5.5`** on purpose —
  Vite 5 ships a Rollup-4 native addon that Windows Smart App Control blocks; Vite 4
  uses pure-JS Rollup 3 so exports install/run on any Windows machine. Do not bump it.

## 5. Architecture overview

```
User URL
   │
   ▼
┌─ route: api.public.clone.$ ──────────────────────────────────────────────┐
│ validatePublicUrl() (SSRF guard) → fetch HTML (redirects capped)        │
│ → parse (node-html-parser) → download assets (dedup, stable names)      │
│ → bundle-module-graph (ES modules + classic scripts) → rewrite HTML to  │
│   local paths → store artifact snapshot                                  │
└──────────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─ route: api.public.clone-preview ─────────────────────────────────────────┐
│ serves the saved clone artifact (iframe) + injects selector overlay       │
│ only in preview mode (never shipped in ZIP)                               │
└───────────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─ route: api.public.clone-export ───────────────────────────────────────────┐
│ collectExportFiles() → staticFiles() | viteFiles() | nextFiles()          │
│ → fflate ZIP → streamed response (avoids "Failed to fetch")                │
└────────────────────────────────────────────────────────────────────────────┘
```

Pipeline phases reported to the UI:
`fetch-document → download-assets → consolidate-bundle → chunk-fetch-and-merge →
media-sweep → sibling-assets → prune-assets → zip` (timings logged with prefix
`[clone-timing]`).

## 6. Core modules (file map)

| File | Responsibility |
|---|---|
| `src/lib/site-cloner.server.ts` | **The heart** (~4700 lines). SSRF guard, fetch, asset crawl/download, bundle consolidation, HTML rewrite/localize, the three exporters, ZIP assembly, Nuxt fidelity (text regions, interior anchors, editable rebuild), runtime safety scripts. |
| `src/lib/html-to-components.ts` | HTML → JSX/TSX conversion. `convertHtmlToReactComponents()` returns `{ sections, components, layout }`; `createJsxSectionComponents()`, smart section naming, attribute sanitization, class cleaning, `extractCleanHtml()`. Sections land at `components/section/<Name>` (singular), reusable pieces at `components/ui/<Name>`. |
| `src/lib/bundle-module-graph.ts` | Module graph of the site's ES modules: static + dynamic imports, chunk ordering, dedup; emits a bundled `main.mjs` and merged classic `main.js`. |
| `src/lib/error-capture.ts` / `error-page.ts` | Server error capture and friendly error rendering. |
| `src/lib/lovable-error-reporting.ts` | Lovable error reporting integration. |
| `src/lib/utils.ts` | `cn()` etc. |
| `src/routes/api.public.clone.$` | Clone pipeline endpoint. |
| `src/routes/api.public.clone-preview.ts` | Preview artifact + selector injection. |
| `src/routes/api.public.clone-export.ts` | Streaming ZIP download endpoint. |
| `src/routes/index.tsx` | Main UI: URL input, clone, preview panel, element/section picker, target selection, download. |
| `src/routes/__root.tsx`, `src/router.tsx`, `src/routeTree.gen.ts` | TanStack Start shell / routing (`routeTree.gen.ts` is auto-generated — never hand-edit). |
| `src/server.ts`, `src/start.ts` | TanStack Start server entrypoints. |

## 7. Export target structures (current, verified)

### Static HTML
```
index.html            (semantic body: header + main(sections) + footer)
css/ global.css header.css hero.css sections.css footer.css   (pretty, multi-line, :root vars)
js/  main.js main.mjs (+ split by function: animation/scroll/interaction where valid)
assets/ images videos audio fonts icons (fully downloaded, local refs)
serve.mjs package.json README.md   (zero-dep local server; `npm start`)
```
### Vite (React) — language default `jsx`
```
src/main.jsx  src/App.jsx  src/pages/Home.jsx
src/components/section/*.jsx   (one editable component per section)
src/components/ui/*.jsx        (reusable icons/buttons/badges)
src/hooks/useSiteScripts.js    (loads archived runtime after mount)
src/utils/loadScript.js  src/index.css
public/js + media        (original runtime & assets, copied verbatim)
```
### Next.js (App Router) — language default `tsx`
```
app/layout.jsx|tsx  app/page.jsx|tsx  app/[...slug]/page.jsx|tsx  app/globals.css
components/section/*  components/ui/*  hooks/useSiteScripts  utils/loadScript  data/site.js
public/  (runtime + assets)   next.config.mjs tsconfig.json package.json README.md
```
Importing works: sections are referenced via `@/components/section/<Name>` (Next)
or `../components/section/<Name>` (Vite page file), matching the `filePath`
returned by the converter — see `referencedModules()`.

## 8. Fidelity preservation (the hard problem)

Because the clone keeps the **original runtime scripts** (not a re-implementation),
the exported app must give the archived bundle the DOM it expects:

- `bootRuntime = !isFullPageRuntimeApp(html) || payload != null` — a full-page
  framework (Nuxt/Framer) only gets its runtime attached when the SSR payload that
  it hydrates from is available; otherwise `useSiteScripts()` becomes a no-op and
  the mirrored markup stands alone.
- **Text edit survival**: `<section>` components carry the text you author. After
  the archived runtime hydrates it may re-render that text away. `useSiteScripts()`
  captures authored text pre-boot and re-applies it after boot via a debounced
  `MutationObserver` + window `load`/interval passes, re-locating nodes by
  `{path, index}` (element-child chains).
- **Vue fragment comments**: React cannot render comment nodes. Nuxt SSR HTML
  contains `<!--[-->` style markers that the hydrating runtime expects at exact
  positions. `collectInteriorAnchors()` records `{path, index, token}` per comment;
  `restoreNuxtAnchors()` re-inserts them right before boot. The editable/Nuxt path
  additionally rebuilds blocks as hand-written JSX preserving the markers
  (`buildNuxtEditable` → `editableComponentCode`, `editableHookLoader`).
- **Safety net** (injected into all exports): blank-screen guard, stuck-overlay
  lifter (`liftStuckOverlays`), `nowrap`-overflow fix for edited text, intro-curtain
  lift timing, script dedup (`DEDUP_SCRIPT`), and Live-Server init guard
  (`window.__siteCloneInitialized` IIFE) that makes refresh smooth.
- **Class/attribute policy**: hash classes (`.framer-xxx`, `.css-1abc2`) are renamed
  to semantic names only when safe; runtime-critical classes/attributes are kept when
  renaming would break visuals or motion (fidelity-first, alias + audit approach).

## 9. Hard ZIP rules (non-negotiable)

- Must be **editable**: text edits in the section files actually show up (no runtime
  overlay that overrides user changes).
- Must be **clean**: pretty, multi-line CSS (one property per line), split per
  section; readable JS; semantic markup; meaningful class names; `:root` CSS variables.
- Must be **complete & self-contained**: all assets downloaded (videos/audio without
  arbitrary cutoffs) and referenced locally, never remote URLs.
- Must **preserve behavior**: original animation libraries ship as local bundles and
  keep running (GSAP, ScrollTrigger, Lenis, Framer Motion, Swiper, Three.js, …);
  responsive media queries intact.
- Must be **buildable**: generated Vite/Next projects `npm install && npm run dev/build`
  without "Unexpected token", blank-page, or style-prop errors.

## 10. Security & constraints

- SSRF guard (`isPrivateHostname()` / `validatePublicUrl()`): blocks
  `localhost`, `0.0.0.0`, loopback, `169.254.169.254`, `*.local`, RFC1918/private
  ranges, and redirects into private networks.
- `REQUEST_TIMEOUT_MS = 45_000`, `MAX_REDIRECTS = 5`.
- Streaming ZIP responses (no JSON/base64 round-trip) avoid the historical
  "Failed to fetch" on large sites; serverless size limits can still apply.
- Never commit secrets; the SSRF guard and public-URL-only policy must stay intact.

## 11. Known limitations

- No headless browser at runtime: computed-style audits and generic animation
  recording can't be guaranteed from `fetch` alone. Fidelity is achieved by
  preserving the original runtime + conservative asset rewriting.
- Full-page-mount sites without a recoverable payload fall back to
  "static markup stands alone" (no runtime attached).
- Asset/time ceilings are a practical reality on serverless hosts; failures should
  surface as clear phase errors, never a bare `Failed to fetch`.
- No automated test suite and no e2e validation of generated projects in CI yet.

## 12. Recent fixes (recent = keep current)

- **2026-10-10 — Vite/Next ZIP shrank to just `index.css`/`globals.css`** (regression):
  `collectInteriorAnchors(html)` was called with the raw HTML **string** instead of a
  parsed element, throwing `TypeError: el.childNodes is not iterable`, which fell into
  the static/fallback catch path of `collectExportFiles()`. Fix: added
  `collectInteriorAnchorsFromHtml()` (parses via `PARSE_OPTIONS`, roots at
  `#__nuxt`/`body`), and `nuxtTextHookSource()` now takes the missing 4th
  `anchors` parameter (its body already referenced it) with a path-based
  `restoreNuxtAnchors`. Verified: Vite and Next exports now contain
  `components/section/*` JSX, pages, hooks, utils, and the css entry. Regression
  repro kept as `_repro_vite.mts` (env `CLONE_URL`, `CLONE_TARGET`).
- Prior fixes (historical, all currently active behavior):
  - JSX parse errors from nested quotes/JSON attributes → filtered/escaped
    (`data-framer-hydrate-v2`-style values, `var(i, …)` with comments, long values).
  - Inline `style="…"` strings in React → removed; styling lives in CSS files.
  - Live Server lag on refresh → IIFE init guard around merged classic scripts.
  - "Failed to fetch" → server-side streaming ZIP.

## 13. Improvement roadmap (suggested)

1. **Automated regression** for the exporter: keep `_repro_vite.mts`, add a Vitest
   harness that clones one fixture (local static HTML) and asserts ZIP structure for
   all three targets, incl. `components/section/*` presence (guards against the
   2026-10-10 class of bug).
2. **E2E build validation**: script that unzips each export and runs
   `npm install && npm run dev/build` in CI; screenshot + Lighthouse compare against
   the reference site.
3. **Broader site matrix**: Framer/Nuxt/Webflow/Wix/vanilla fixtures; add per-framework
   "preserve vs clean" regression cases.
4. **Full-page-mount resilience**: extend the payload-aware boot fallback so more
   SSR frameworks keep their runtime without wiping React-authored text.
5. **Download-phase performance**: parallelize/shard the ~50s asset download for
   heavy sites; caching and incremental re-clone.
6. **Accessibility**: restore landmarks/ARIA roles in generated sections after the
   semantic rebuild.
7. **Hygiene**: normalize line endings vs Prettier (`endOfLine`), clear the stale
   `no-irregular-whitespace` issue, and move one-off root scripts under `scripts/`
   with docs instead of deleting them ad hoc.

## 14. Gotchas for contributors

- File is `site-cloner.server.ts` — it's saved with **CRLF** line endings while
  Prettier expects LF; the whole file currently lints red for `prettier/prettier`.
  Don't fight it with `--fix` unless you normalize the repo globally.
- `routeTree.gen.ts` is generated — never hand-edit.
- `npx --yes tsx _repro_vite.mts` is the quickest way to exercise the full clone
  + export pipeline without the UI (Node 20+, `tsx` isn't installed globally).
- Follow the Lovable rules in `AGENTS.md`: never rewrite/force-push published git
  history; keep pushed branches in a working state.