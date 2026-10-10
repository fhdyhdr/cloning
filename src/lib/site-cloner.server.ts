import { zipSync, strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { bundleModuleGraph } from "./bundle-module-graph";
import { convertHtmlToReactComponents, extractCleanHtml } from "./html-to-components";
import { createHash } from "node:crypto";
import { parse as parseHtml, HTMLElement as ParsedHTMLElement } from "node-html-parser";
import * as prettier from "prettier/standalone";
import parserBabel from "prettier/plugins/babel";
import * as parserEstree from "prettier/plugins/estree";
import parserPostcss from "prettier/plugins/postcss";
import parserHtml from "prettier/plugins/html";

const PARSE_OPTIONS = {
  comment: true,
  blockTextElements: { script: true, noscript: true, style: true, pre: true },
} as const;

export type ExportTarget = "static" | "vite" | "next";

// Output source language. Vite defaults to plain JSX, Next.js to TSX, but both
// can be forced the other way: "jsx" emits .jsx/.js without any TypeScript
// surface, "tsx" emits .tsx/.ts plus tsconfig/global.d.ts so the clone can be
// type-checked.
export type ExportLanguage = "jsx" | "tsx";

const languageExtension = (language: ExportLanguage): string =>
  language === "jsx" ? "jsx" : "tsx";
const codeExtension = (language: ExportLanguage): string => (language === "jsx" ? "js" : "ts");

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 5;

function isPrivateHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "169.254.169.254" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  );
}

export function validatePublicUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL tidak valid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || isPrivateHostname(url.hostname)) {
    throw new Error("Hanya URL web publik HTTP/HTTPS yang dapat diproses.");
  }
  return url;
}

async function fetchPublic(
  url: URL,
  referer?: string,
  redirects = 0,
  asset = false,
): Promise<Response> {
  if (redirects > MAX_REDIRECTS) throw new Error("Terlalu banyak redirect dari situs sumber.");
  validatePublicUrl(url.toString());
  const headers: Record<string, string> = {
    // A plain browser User-Agent goes much further than a bot UA: several
    // hosts (CodeSandbox, some CDNs, bot-blocking edge stacks) answer 400 to
    // anything that does not look like a real Chrome request. Some also demand
    // a Referer and 400 subresource fetches without one.
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
  };
  // Asset fetches must not advertise a preference for HTML: preview/proxy
  // hosts like CodeSandbox answer 400 to any subresource request whose Accept
  // mentions text/html ("CodeSandbox preview does not accept that request").
  headers["Accept"] = asset
    ? "*/*"
    : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
  if (referer) headers["Referer"] = referer;
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers,
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`Redirect ${response.status} tanpa tujuan.`);
    return fetchPublic(new URL(location, url), referer, redirects + 1, asset);
  }
  if (!response.ok) throw new Error(`Situs sumber merespons HTTP ${response.status}.`);
  return response;
}

function removeFrameBlockingMarkup(html: string) {
  return html.replace(
    /<meta[^>]+http-equiv=["'](?:content-security-policy|x-frame-options)["'][^>]*>/gi,
    "",
  );
}

function injectBeforeHeadEnd(html: string, markup: string) {
  return /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${markup}</head>`)
    : `${markup}${html}`;
}

function injectBeforeBodyEnd(html: string, markup: string) {
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${markup}</body>`)
    : `${html}${markup}`;
}

const selectorScript = String.raw`<style data-site-cloner-selector>
html.site-cloner-selecting * { cursor: crosshair !important; }
.site-cloner-hover { outline: 2px solid #ff4fd8 !important; outline-offset: -2px !important; }
.site-cloner-selected { outline: 3px solid #ff4fd8 !important; outline-offset: -3px !important; }
</style><script data-site-cloner-selector>(function(){
let active=false,hovered=null,selected=null;
function path(el){if(!el)return '';const parts=[];while(el&&el!==document.body){let p=el.tagName.toLowerCase();if(el.id){p+='#'+CSS.escape(el.id);parts.unshift(p);break;}const parent=el.parentElement;if(parent){const same=[...parent.children].filter(x=>x.tagName===el.tagName);if(same.length>1)p+=':nth-of-type('+(same.indexOf(el)+1)+')';}parts.unshift(p);el=parent;}return 'body > '+parts.join(' > ')}
addEventListener('message',e=>{if(e.data?.type==='site-cloner:selection-mode'){active=!!e.data.active;document.documentElement.classList.toggle('site-cloner-selecting',active);if(!active&&hovered)hovered.classList.remove('site-cloner-hover')}});
document.addEventListener('pointerover',e=>{if(!active)return;if(hovered)hovered.classList.remove('site-cloner-hover');hovered=e.target;hovered.classList.add('site-cloner-hover')},true);
document.addEventListener('click',e=>{if(!active)return;e.preventDefault();e.stopPropagation();if(selected)selected.classList.remove('site-cloner-selected');selected=e.target;selected.classList.remove('site-cloner-hover');selected.classList.add('site-cloner-selected');parent.postMessage({type:'site-cloner:selected',selector:path(selected),label:(selected.getAttribute('aria-label')||selected.textContent||selected.tagName).trim().replace(/\s+/g,' ').slice(0,80)},'*')},true);
parent.postMessage({type:'site-cloner:ready'},'*');
})();</script>`;

// Preview is served same-origin and renders the EXACT static archive that the
// ZIP ships. The origin page cannot be previewed directly: its module scripts,
// fonts and JSON payloads are fetched cross-origin, and the origin sends no
// Access-Control-Allow-Origin header, so the browser CORS-blocks them Ã¢â‚¬â€ no
// hydration, no Lenis, no animations, native scroll locked. The preview
// therefore references relative asset paths resolved against the local
// /api/public/clone/<id>/ tree, backed by the cached static build.
const previewTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".webmanifest": "application/manifest+json",
};

function previewKey(source: string) {
  return Buffer.from(source, "utf8").toString("base64url");
}

export function previewSourceFromKey(id: string) {
  return Buffer.from(id, "base64url").toString("utf8");
}

export function previewBaseUrl(source: string) {
  return `/api/public/clone/${previewKey(source)}/`;
}

// Cached static builds power both the preview document and every asset request,
// so the preview is pixel-identical to the ZIP and repeated downloads are free.
// A full build can take tens of seconds on heavy runtimes (Framer ships a big
// merged bundle), so the cache also tracks the in-flight promise (single-flight:
// concurrent preview/export/asset requests share one build) and records faults
// with a short retry window so a broken URL never triggers a build per reload.
const previewCache = new Map<string, { files: Record<string, Uint8Array>; at: number }>();
const previewInflight = new Map<string, Promise<Record<string, Uint8Array>>>();
const previewFaults = new Map<string, { message: string; at: number }>();
const PREVIEW_CACHE_TTL_MS = 30 * 60 * 1000;
const PREVIEW_CACHE_MAX = 4;
const PREVIEW_FAULT_TTL_MS = 5 * 60 * 1000;

export function previewReady(source: string) {
  const key = previewKey(validatePublicUrl(source).toString());
  const hit = previewCache.get(key);
  if (hit && Date.now() - hit.at < PREVIEW_CACHE_TTL_MS) return true;
  const fault = previewFaults.get(key);
  return !!fault && Date.now() - fault.at < PREVIEW_FAULT_TTL_MS;
}

export async function getPreviewFiles(source: string): Promise<Record<string, Uint8Array>> {
  const key = previewKey(validatePublicUrl(source).toString());
  const hit = previewCache.get(key);
  if (hit && Date.now() - hit.at < PREVIEW_CACHE_TTL_MS) return hit.files;
  const fault = previewFaults.get(key);
  if (fault && Date.now() - fault.at < PREVIEW_FAULT_TTL_MS) throw new Error(fault.message);
  const existing = previewInflight.get(key);
  if (existing) return existing;
  const building = (async () => {
    const files = await collectExportFiles(source, "static", undefined, undefined);
    previewCache.set(key, { files, at: Date.now() });
    if (previewCache.size > PREVIEW_CACHE_MAX) {
      const oldest = [...previewCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) previewCache.delete(oldest[0]);
    }
    return files;
  })();
  previewInflight.set(key, building);
  building.catch((error) => {
    previewFaults.set(key, {
      message: error instanceof Error ? error.message : "Clone gagal diproses.",
      at: Date.now(),
    });
  });
  try {
    return await building;
  } finally {
    previewInflight.delete(key);
  }
}

// Kick off the static build in the background so the first paint doesn't block
// on it: the /api/public/clone/<id>/ route serves a splash while it runs.
export function startPreviewBuild(source: string) {
  void getPreviewFiles(source).catch(() => {});
}

export function previewSplashHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preparing preview</title>
    <style>
      html, body { margin: 0; height: 100%; background: #ffffff; color: #6b7280;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        display: flex; align-items: center; justify-content: center; }
      p { margin: 0; font-size: 12px; letter-spacing: 0.12em;
        text-transform: uppercase; }
    </style>
  </head>
  <body>
    <p>Preparing preview&hellip;</p>
    <script>
      // Long-poll the same URL: the server responds only once the shared static
      // build for this preview is finished (real document) or failed (error
      // page). One reload at the end means no repeated flashing between states.
      (function () {
        function check() {
          fetch(window.location.href, { headers: { "X-Preview-Await": "1" } })
            .then(function () { window.location.reload(); })
            .catch(function () { window.setTimeout(check, 1200); });
        }
        check();
      })();
    </script>
  </body>
</html>
`;
}

export async function buildPreview(source: string) {
  const requested = validatePublicUrl(source);
  const html = new TextDecoder().decode(
    (await getPreviewFiles(requested.toString()))["index.html"],
  );
  const doc = injectBeforeHeadEnd(
    html,
    `<base href="${escapeAttribute(previewBaseUrl(requested.toString()))}">`,
  );
  return injectBeforeBodyEnd(doc, selectorScript);
}

export async function buildPreviewAsset(source: string, pathname: string) {
  const requested = validatePublicUrl(source);
  const files = await getPreviewFiles(requested.toString());
  const rel = pathname.replace(/^\/+/, "");
  const bytes = rel ? files[rel] : undefined;
  if (!bytes) return null;
  const lower = rel.split("?")[0]!.toLowerCase();
  const ext = lower.match(/\.([a-z0-9]+)$/)?.[1];
  const type = ext
    ? (previewTypes[`.${ext}`] ?? "application/octet-stream")
    : "application/octet-stream";
  return { bytes, type };
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function cleanSourceHtml(html: string, source: URL, withBase = true) {
  const cleaned = removeFrameBlockingMarkup(html)
    .replace(/<style data-site-cloner-selector>[\s\S]*?<\/style>/gi, "")
    .replace(/<script data-site-cloner-selector>[\s\S]*?<\/script>/gi, "");
  if (!withBase) return cleaned;
  return injectBeforeHeadEnd(cleaned, `<base href="${escapeAttribute(source.toString())}">`);
}

type DownloadedAsset = {
  original: string;
  path: string;
  bytes: Uint8Array;
  textual: boolean;
  // Local archive paths that mirror the asset's original server-relative URL.
  // Runtime-concatenated references (e.g. canvas filmstrip frames built as
  // `DIR + pad(i) + '.jpg'`) can never be statically rewritten, so their target
  // files are additionally archived at the exact path the browser will request.
  aliases?: string[];
};

const MAX_ASSETS = 6000;
// Oversized artwork and media must not be dropped silently: the user expects a
// fully self-contained archive. Caps stay only as a guard against runaway /
// memory-hostile pages, set high enough that real sites never hit them.
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
// Media (images/video/audio/fonts) share this budget; script/text modules are
// tracked separately so the runtime dependency graph is always downloaded,
// regardless of how heavy the page's media payload is. Filmstrip heroes and
// media-heavy portfolios can push hundreds of MB of frames, so the cap sits far
// above realistic payloads while still fitting the worker's memory envelope.
const MAX_MEDIA_BYTES = 768 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(["css", "js", "mjs", "json", "svg", "txt", "xml"]);

function asciiHead(bytes: Uint8Array, length = 512) {
  let out = "";
  for (let index = 0; index < Math.min(length, bytes.byteLength); index += 1)
    out += String.fromCharCode(bytes[index] ?? 0);
  return out;
}

// Format is decided by magic bytes first, then MIME, then the URL extension Ã¢â‚¬â€
// never by the URL alone, so opaque `.bin` payloads land with a real extension.
function sniffAsset(url: URL, contentType: string, bytes: Uint8Array) {
  const head = asciiHead(bytes);
  const byte = (index: number) => bytes[index] ?? 0;
  let extension = "";
  if (head.startsWith("\x89PNG")) extension = "png";
  else if (head.startsWith("GIF8")) extension = "gif";
  else if (byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff) extension = "jpg";
  else if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") extension = "webp";
  else if (head.startsWith("RIFF") && head.slice(8, 12) === "WAVE") extension = "wav";
  else if (head.startsWith("wOF2")) extension = "woff2";
  else if (head.startsWith("wOFF")) extension = "woff";
  else if (head.startsWith("OTTO")) extension = "otf";
  else if (
    head.startsWith("true") ||
    head.startsWith("ttcf") ||
    (byte(0) === 0 && byte(1) === 1 && byte(2) === 0 && byte(3) === 0)
  )
    extension = "ttf";
  else if (head.slice(4, 8) === "ftyp")
    extension = head.slice(8, 12).includes("qt") ? "mov" : "mp4";
  else if (byte(0) === 0x1a && byte(1) === 0x45 && byte(2) === 0xdf && byte(3) === 0xa3)
    extension = "webm";
  else if (head.startsWith("OggS")) extension = "ogg";
  else if (head.startsWith("ID3") || (byte(0) === 0xff && (byte(1) & 0xe0) === 0xe0))
    extension = "mp3";
  else if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(head)) extension = "svg";
  else if (head.startsWith("\x00\x00\x01\x00")) extension = "ico";

  if (!extension) {
    const mime = contentType.toLowerCase();
    const mimeMap: Record<string, string> = {
      "image/svg+xml": "svg",
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/avif": "avif",
      "image/x-icon": "ico",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/ogg": "ogg",
      "font/woff2": "woff2",
      "font/woff": "woff",
      "font/ttf": "ttf",
      "font/otf": "otf",
      "text/css": "css",
      "application/json": "json",
    };
    if (mimeMap[mime]) extension = mimeMap[mime]!;
    else if (mime.includes("javascript")) extension = "js";
    else if (mime.includes("css")) extension = "css";
    else if (mime.includes("json")) extension = "json";
  }

  if (!extension) {
    const fromPath = /\.([a-z0-9]{2,5})$/i.exec(url.pathname)?.[1]?.toLowerCase();
    if (fromPath && fromPath !== "bin") extension = fromPath === "mjs" ? "mjs" : fromPath;
  }
  if (!extension) extension = "txt";

  const folder = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(extension)
    ? "assets/images"
    : extension === "ico"
      ? "assets/icons"
      : ["mp4", "webm", "mov"].includes(extension)
        ? "assets/videos"
        : ["mp3", "wav", "ogg"].includes(extension)
          ? "assets/audio"
          : ["woff", "woff2", "ttf", "otf", "eot"].includes(extension)
            ? "assets/fonts"
            : extension === "css"
              ? "css"
              : ["js", "mjs"].includes(extension)
                ? "js"
                : "assets/data";

  return { extension, folder, textual: TEXT_EXTENSIONS.has(extension) };
}

function safeAssetName(url: URL, extension: string) {
  const raw = decodeURIComponent(url.pathname.split("/").pop() || "asset").replace(
    /[^a-z0-9._-]+/gi,
    "-",
  );
  const base = raw.replace(/\.[a-z0-9]{2,5}$/i, "") || "asset";
  const hash = createHash("sha1").update(url.toString()).digest("hex").slice(0, 8);
  return `${hash}-${base}.${extension}`;
}

// Collects absolute URLs from markup, CSS `url()` / `@import`, and ES module specifiers.
function discoverAssetUrls(text: string, base: URL) {
  const found = new Set<string>();
  // Only self-serveable file types are archive candidates; page URLs, telemetry
  // endpoints and minified-JS template-literal fragments otherwise flood the
  // crawl with hundreds of guaranteed 4xx fetches.
  const ASSET_EXT =
    /\.(?:js|mjs|cjs|css|json|html|jpg|jpeg|png|gif|webp|avif|svg|ico|mp4|webm|mov|m4v|mp3|wav|ogg|woff2?|ttf|otf|pdf|zip|txt|webmanifest)$/i;
  const push = (raw: string) => {
    const value = raw.trim().replace(/&amp;/g, "&");
    if (!value || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return;
    // Backticks, braces and `${` interpolation prove the string is a fragment
    // of minified JS, not a real asset URL.
    if (/[`"{}]/.test(value)) return;
    try {
      const url = new URL(value, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      url.hash = "";
      if (!ASSET_EXT.test(url.pathname)) return;
      found.add(url.toString());
    } catch {
      // Ignore malformed values embedded in source scripts.
    }
  };
  // Serialized Nuxt/Next payloads escape every "/" as "\u002f" (e.g.
  // "\u002Fvideos\u002Fshowreel.mp4"), so the plain "/videos/Ã¢â‚¬Â¦" scans below never
  // match and runtime-fetched videos/posters are missed. Scan a decoded copy too.
  let decoded = "";
  if (/\\u002f/i.test(text)) decoded = text.replace(/\\u002f/gi, "/");
  const scanText = decoded.length ? `${text}\n${decoded}` : text;
  for (const match of scanText.matchAll(/https?:\/\/[^\s"'<>()`,]+/g)) push(match[0]);
  for (const match of scanText.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) push(match[1] ?? "");
  for (const match of scanText.matchAll(/@import\s+['"]([^'"]+)['"]/gi)) push(match[1] ?? "");
  for (const match of scanText.matchAll(/(?:import|export)[^'"]{0,40}from\s*['"]([^'"]+)['"]/g))
    push(match[1] ?? "");
  for (const match of scanText.matchAll(/import\(\s*['"`]([^'"`]+)['"`]\s*\)/g))
    push(match[1] ?? "");
  for (const match of scanText.matchAll(
    /(?:src|href|poster|data-src|data-img|data-cursor-img|data-image|data-thumb|data-poster|data-background-image)\s*=\s*['"]([^'"]+)['"]/gi,
  ))
    push(match[1] ?? "");
  for (const match of text.matchAll(/srcset\s*=\s*['"]([^'"]+)['"]/gi)) {
    for (const candidate of (match[1] ?? "").split(","))
      push(candidate.trim().split(/\s+/)[0] ?? "");
  }
  // Media paths baked into script string literals: `<img>/<video>` src values
  // assigned from JS, canvas frame sprites and other runtime-built references
  // that attribute scraping never sees. Restricted to asset-ish folder roots so
  // unrelated quoted strings (class names, copy text, CSS selectors) stay out.
  // `push` discards values containing interpolation/backticks/braces, which
  // filters out minified template-literal fragments.
  for (const match of scanText.matchAll(/['"`]([^'"`\n]{3,400})['"`]/g)) {
    const candidate = match[1]!;
    if (
      !/(?:^|\/)(?:assets|static|media|images?|videos?|fonts?|uploads?|css|js|img|public)\//i.test(
        candidate,
      )
    )
      continue;
    push(candidate);
  }
  // Public-asset manifests store values in object literals (`path:"/videos/
  // demo.mp4"`). The quote-pairing scan above consumes every other string, so
  // a value like `path:"/assets/lottie/0Intro/intro.json"` sits between two
  // matched pairs (its opening quote closes the previous string and its closing
  // quote opens the next one) and would never open a match. Scan for path-like
  // tokens directly Ã¢â‚¬â€ restricted to the same asset roots plus a real file
  // extension, which keeps template fragments (`/videos/${name}.mp4`) and prose
  // out by construction. JSON is included so animation/loader manifests
  // ("intro.json") referenced only from route chunks are also discovered.
  for (const match of scanText.matchAll(
    /\/(?:assets|static|media|images?|videos?|fonts?|uploads?|js|css|img|public)\/[A-Za-z0-9_.%\-/\\]+\.(?:json|mp4|webm|mov|m4v|mp3|wav|ogg|webp|avif|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|webmanifest)(?=[^A-Za-z0-9_]|$)/gi,
  )) {
    push(match[0]!);
  }
  for (const match of scanText.matchAll(
    /(?:path|animationData|src|url)\s*[:=]\s*['"]([^'"`\n]{1,300}\.(?:json|mp4|webm|mov|m4v|mp3|wav|ogg|webp|avif|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|webmanifest))['"]/gi,
  )) {
    push(match[1]!);
  }
  for (const match of scanText.matchAll(
    /['"](\/[A-Za-z0-9_.-]+\.(?:json|mp4|webm|mov|m4v|mp3|wav|ogg|webp|avif|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|webmanifest))['"]/gi,
  )) {
    push(match[1]!);
  }

  return [...found];
}

// Runtime-built numbered media sequences ("filmstrip" scroll heroes, frame
// sprites) are invisible to URL scraping because the script constructs them
// from constants, e.g.:
//   const FRAME_DIR = 'assets/images/hero%20sequence/';
//   const FRAME_EXT = '.jpg'; const FRAME_PAD = 4; const TOTAL_FRAMES = 341;
// When a script declares a literal frame count plus an asset-folder base,
// enumerate the frames so the archive can satisfy those runtime URLs offline.
function discoverFrameSequence(text: string, base: URL) {
  const found: string[] = [];
  const paths = new Set<string>();
  const declared = /TOTAL_FRAMES\s*[:=]\s*(\d{2,5})/i.exec(text);
  if (!declared) return { found, paths };
  const total = Number(declared[1]!);
  if (!(total >= 2 && total <= 4000)) return { found, paths };
  const ext = /FRAME_EXT\s*[:=]\s*['"]([a-z0-9]{2,5})['"]/i.exec(text)?.[1] ?? "jpg";
  const pad = Math.min(Number(/FRAME_PAD\s*[:=]\s*(\d{1,2})/i.exec(text)?.[1] ?? 4), 8);
  const baseDirs = new Set<string>();
  for (const match of text.matchAll(/['"`]([^'"`\n]{3,400})['"`]/g)) {
    const value = match[1]!;
    if (!value.endsWith("/")) continue;
    if (/\$\{/.test(value) || value.includes("http")) continue;
    if (!/(?:assets|static|media|images?|videos?|fonts?|uploads?|img|public)\//i.test(value))
      continue;
    if (total * (baseDirs.size + 1) > 4000) break;
    baseDirs.add(value);
  }
  for (const dir of baseDirs) {
    for (let n = 1; n <= total; n += 1) {
      try {
        const url = new URL(`${dir}${String(n).padStart(pad, "0")}.${ext}`, base);
        url.hash = "";
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        found.push(url.toString());
        paths.add(url.pathname);
      } catch {
        // Skip malformed bases.
      }
    }
  }
  return { found, paths };
}

// Template-literal asset URLs are built at runtime from a variable, e.g.
//   `../assets/img/programs/program-desc-${slug}.jpg`
// so the crawler never sees a concrete file and the route (here: /programs/<slug>)
// renders its illustration as a broken image. When a bundle assembles an asset
// path from `${...}`, enumerate the plausible values of the interpolated slot
// from the identifiers the same file already branches on (`case "3-to-18":`,
// slug-like string literals) and archive each resolved URL. Bounded by MAX so a
// pathological template cannot flood the crawl.
function discoverInterpolatedAssets(text: string, base: URL) {
  const found: string[] = [];
  const paths = new Set<string>();
  const templates: string[] = [];
  for (const match of text.matchAll(/`([^`\n]{2,300})`/g)) {
    const value = match[1]!;
    if (!value.includes("${")) continue;
    if (
      !/\.(?:jpe?g|png|webp|avif|gif|svg|mp4|webm|mov|m4v|mp3|wav|ogg|json|woff2?|ttf|otf)(?:[?#`]|`|$)/i.test(
        value,
      )
    )
      continue;
    if (
      !/(?:assets|static|media|images?|videos?|fonts?|uploads?|img|public|programs?)\//i.test(value)
    )
      continue;
    // Only a single `${...}` slot is enumerated; multi-slot templates explode.
    if ((value.match(/\$\{/g) ?? []).length !== 1) continue;
    templates.push(value);
  }
  if (!templates.length) return { found, paths };

  // Candidate values for the slot. Prefer the precise per-route labels the file
  // already branches on (`case "3-to-18":`), which yields the handful of slugs a
  // program route can take; only when none exist fall back to slug-like string
  // literals (lowercase, dash-separated tokens).
  const candidates = new Set<string>();
  for (const match of text.matchAll(/case\s*["']([A-Za-z0-9][A-Za-z0-9_-]{1,40})["']/g))
    candidates.add(match[1]!);
  if (candidates.size === 0) {
    for (const match of text.matchAll(/["']([a-z0-9]+(?:-[a-z0-9]+){1,5})["']/g))
      candidates.add(match[1]!);
  }
  // A template branching over hundreds of labels is not a per-route asset; skip
  // rather than enumerate a flood of guaranteed 404s.
  if (candidates.size === 0 || candidates.size > 40) return { found, paths };

  for (const template of templates) {
    for (const candidate of candidates) {
      const resolved = template.replace(/\$\{[^}]*\}/, candidate);
      try {
        const url = new URL(resolved, base);
        url.hash = "";
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        found.push(url.toString());
        paths.add(url.pathname);
      } catch {
        // Skip malformed combinations.
      }
    }
  }
  return { found, paths };
}

// Recursively downloads every asset, following dependencies inside CSS and JS
// modules, deduplicating identical payloads and respecting a memory budget.
async function downloadAssets(html: string, base: URL) {
  const assets = new Map<string, DownloadedAsset>();
  const byContent = new Map<string, DownloadedAsset>();
  const decoder = new TextDecoder();
  const seen = new Set<string>();
  // pathnames of enumerated filmstrip frames, used to give those assets
  // readable origin-path aliases so runtime-built URLs resolve offline.
  const framePaths = new Set<string>();
  let mediaBytes = 0;
  let textBytes = 0;
  const seeded = new Set(discoverAssetUrls(html, base));
  const seedFrames = discoverFrameSequence(html, base);
  for (const path of seedFrames.paths) framePaths.add(path);
  for (const item of seedFrames.found) seeded.add(item);
  const seedInterpolated = discoverInterpolatedAssets(html, base);
  for (const path of seedInterpolated.paths) framePaths.add(path);
  for (const item of seedInterpolated.found) seeded.add(item);
  let frontier = [...seeded].filter((item) => !seen.has(item) && seen.add(item));

  const admit = (asset: DownloadedAsset, original: string): boolean => {
    const budget = asset.textual ? MAX_TEXT_BYTES : MAX_MEDIA_BYTES;
    const used = asset.textual ? textBytes : mediaBytes;
    if (used + asset.bytes.byteLength > budget) return false;
    if (asset.textual) textBytes += asset.bytes.byteLength;
    else mediaBytes += asset.bytes.byteLength;
    assets.set(original, asset);
    return true;
  };

  for (let depth = 0; depth < 12 && frontier.length; depth += 1) {
    const queue = [...frontier];
    const next: string[] = [];
    const workers = Array.from({ length: 24 }, async () => {
      while (queue.length) {
        if (assets.size >= MAX_ASSETS) return;
        const original = queue.shift();
        if (!original) return;
        try {
          const url = validatePublicUrl(original);
          let response: Response | null = null;
          // A CDN that answers a JS request with a transient 403/429/5xx must
          // not be taken as a successful download; permanent 404s are skipped.
          for (let attempt = 0; attempt < 4 && !response; attempt += 1) {
            if (attempt)
              await new Promise((resolve) => setTimeout(resolve, 200 * attempt * attempt));
            try {
              const candidate = await fetchPublic(url, base.href, 0, true);
              const isHtml = (candidate.headers.get("content-type") ?? "").includes("text/html");
              if (candidate.ok && !isHtml) {
                response = candidate;
                break;
              }
              if (candidate.status === 403 || candidate.status === 429 || candidate.status >= 500)
                continue;
              break;
            } catch {
              continue;
            }
          }
          if (!response) continue;
          const contentType =
            response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
          if (contentType.includes("text/html")) continue;
          if (contentType.includes("text/html")) continue;
          const declared = Number(response.headers.get("content-length") ?? "0");
          if (declared > MAX_ASSET_BYTES) continue;
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > MAX_ASSET_BYTES) continue;
          const digest = createHash("sha1").update(bytes).digest("hex");
          const duplicate = byContent.get(digest);
          if (duplicate) {
            // Same bytes behind another URL: reuse the single archived copy.
            assets.set(original, { ...duplicate, original });
            continue;
          }
          const { extension, folder, textual } = sniffAsset(url, contentType, bytes);
          const asset: DownloadedAsset = {
            original,
            path: `${folder}/${safeAssetName(url, extension)}`,
            bytes,
            textual,
          };
          if (!admit(asset, original)) continue;
          byContent.set(digest, asset);
          if (textual) {
            const scriptText = decoder.decode(bytes);
            const isModuleScript = /\.(?:js|mjs|cjs)(?:[?#]|$)/i.test(url.pathname);
            // Two resolution bases are needed for a JS module. Its own URL is the
            // correct base for module specifiers Ã¢â‚¬â€ static `import Ã¢â‚¬Â¦ from "./x.js"`
            // and dynamic `import("./chunk.js")` always resolve relative to the
            // file (a Nuxt entry's `import("./DQy71oTq.js")` lives under /_nuxt/,
            // not the page root; resolving it against the page 404s and aborts the
            // boot, killing lenis/smooth-scroll and every lazy route). Runtime
            // string media (`src = "assets/x.jpg"`) instead resolve against the
            // document URL, so the page base is tried as a fallback.
            const bases = isModuleScript ? [url, base] : [url];
            const discoverFrom = (
              fn: (t: string, b: URL) => { found: string[]; paths: Set<string> },
            ) => {
              for (const discoverBase of bases) {
                const result = fn(scriptText, discoverBase);
                for (const path of result.paths) framePaths.add(path);
                for (const item of result.found) {
                  if (!seen.has(item)) {
                    seen.add(item);
                    next.push(item);
                  }
                }
              }
            };
            discoverFrom(discoverFrameSequence);
            discoverFrom(discoverInterpolatedAssets);
            for (const discoverBase of bases) {
              for (const dependency of discoverAssetUrls(scriptText, discoverBase)) {
                if (!seen.has(dependency)) {
                  seen.add(dependency);
                  next.push(dependency);
                }
              }
            }
          }
        } catch {
          // Keep the source URL as a fidelity fallback when a host refuses download.
        }
      }
    });
    await Promise.all(workers);
    frontier = next;
  }

  // Filmstrip assets are only ever addressed by the runtime through
  // concatenated URLs, so they must live at their decoded origin path (with a
  // matching alias). Doing this after the crawl keeps ordering under parallelism
  // from deciding which URLs were scanned before download.
  return [...assets.values()].map((asset) => {
    let framePath: string | null = null;
    try {
      const u = new URL(asset.original);
      if (framePaths.has(u.pathname)) {
        framePath = decodeURIComponent(u.pathname.replace(/^\//, ""));
      } else if (
        u.pathname.split("/").length <= 3 &&
        /\.(json|svg|png|jpg|mp4|webm)$/i.test(u.pathname)
      ) {
        framePath = decodeURIComponent(u.pathname.replace(/^\//, ""));
      }
    } catch {
      // Keep the hashed-folder layout for unparseable originals.
    }
    return framePath ? { ...asset, path: framePath, aliases: [framePath] } : asset;
  });
}

function rewriteReferences(text: string, assets: DownloadedAsset[]) {
  let output = text;
  for (const asset of assets) {
    const local = `/${asset.path}`;
    output = output.split(asset.original).join(local);
    output = output.split(asset.original.replace(/&/g, "&amp;")).join(local);
  }
  return output;
}

// Relative specifiers inside a CSS/JS file resolve against that file's own URL,
// so they must be resolved before they can be mapped onto bundled local copies.
// `altBase` lets module files fall back to page-relative resolution for runtime
// strings that were authored against the document URL instead.
function rewriteRelativeReferences(
  text: string,
  base: URL,
  byUrl: Map<string, string>,
  altBase?: URL,
) {
  const localFor = (raw: string) => {
    const value = raw.trim();
    if (!value || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return undefined;
    for (const candidate of [base, ...(altBase ? [altBase] : [])]) {
      try {
        const resolved = new URL(value, candidate);
        resolved.hash = "";
        const hit = byUrl.get(resolved.toString());
        if (hit) return hit;
      } catch {
        // Keep scanning the remaining bases.
      }
    }
    return undefined;
  };
  // Targeted module-specifier passes first: generic quote pairing is unreliable in
  // minified bundles full of template literals.
  let output = text.replace(
    /(import\(\s*|(?:from|import)\s*)(['"`])([^'"`\n]{1,400})\2/g,
    (match, prefix: string, quote: string, value: string) => {
      const local = localFor(value);
      return local ? `${prefix}${quote}${local}${quote}` : match;
    },
  );
  // Generic quoted-string passes, run separately per quote type. A combined
  // `["']` class mis-pairs once a string contains the other quote char or an
  // empty value (`""`): a `{1,..}` quantifier skips empty pairs, and the engine
  // then reuses the closing quote as an opening quote, shifting every later
  // token by one until the end of the file. Allowing zero-length content and
  // excluding only the *matching* quote keeps alignment intact.
  output = output.replace(/"([^"\n]{0,20000})"/g, (match, value: string) => {
    const local = localFor(value);
    return local ? `"${local}"` : match;
  });
  output = output.replace(/'([^'\n]{0,20000})'/g, (match, value: string) => {
    const local = localFor(value);
    return local ? `'${local}'` : match;
  });
  output = output.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, quote: string, value: string) => {
      const local = localFor(value);
      return local ? `url(${quote}${local}${quote})` : match;
    },
  );

  return output;
}

// Rewrites CSS/JS dependency graphs in place so the archive never falls back to the origin.
// `pageBase` is only required for scripts: their relative media strings resolve
// against the document URL at runtime, not against the script file itself.
function rewriteTextualAssets(assets: DownloadedAsset[], pageBase?: URL) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const byUrl = new Map(assets.map((asset) => [asset.original, `/${asset.path}`]));
  return assets.map((asset) => {
    if (!asset.textual) return asset;
    // The collection loader builds `new URL('./index.framercms', <absolute>)`.
    // Rewriting the base argument to a relative local path makes the
    // constructor throw "Invalid base URL" at runtime, which takes the whole
    // Framer module non-interactive. Freeze every `new URL(...)` argument pair
    // out of the rewrites so the base stays absolute and the call stays valid.
    const frozen = new Map<number, { head: string; body: string; tail: string }>();
    let masked = decoder.decode(asset.bytes);
    masked = masked.replace(
      /(new URL\s*\(\s*)(['"`])([^'"`\n]{1,500})\2((?:\s*,\s*)(['"`])([^'"`\n]{1,500})\5)?(\s*\))/g,
      (
        _match,
        head: string,
        q1: string,
        a: string,
        midWithArg: string | undefined,
        _q2: string | undefined,
        _b: string | undefined,
        tail: string,
      ) => {
        const token = `__WVR_URL_${frozen.size}__`;
        const body = `${q1}${a}${q1}${midWithArg ?? ""}`;
        frozen.set(frozen.size, { head, body, tail });
        return `${head}${token}${tail}`;
      },
    );
    let text = rewriteReferences(masked, assets);
    try {
      // Module imports resolve against the *module* URL, not the page. CSS
      // url() and runtime strings resolve against the file too, so every
      // textual asset resolves relative specifiers against its own URL first and
      // falls back to the page URL for strings authored document-relative.
      const assetBase = new URL(asset.original);
      text = rewriteRelativeReferences(text, assetBase, byUrl, pageBase);
    } catch {
      // Keep the absolute-only rewrite when the asset URL cannot be parsed.
    }
    for (const [token, frozenParts] of frozen) {
      text = text
        .split(`__WVR_URL_${token}__`)
        .join(`${frozenParts.head}${frozenParts.body}${frozenParts.tail}`);
    }
    return { ...asset, bytes: encoder.encode(text) };
  });
}

const STRUCTURAL_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT"]);

type SelectedRegion = { selector: string; path: number[] | null };

// Element-children index path from <body> to the element. It mirrors the
// browser DOM (node-html-parser also sees text/comment nodes), so it can be
// resolved again on the hydrated page exactly the way content-edit.js does.
function elementChildPath(el: unknown): number[] | null {
  const path: number[] = [];
  let node = el as {
    parentNode?: unknown;
    rawTagName?: string;
    childNodes?: { nodeType: number }[];
  } | null;
  while (node) {
    const parent = node.parentNode as
      (typeof node & { childNodes?: { nodeType: number }[] }) | null;
    if (!parent) return null;
    const tag = (node.rawTagName ?? "").toLowerCase();
    if (tag === "body") break;
    const kids = (parent.childNodes ?? []).filter((child) => child.nodeType === 1);
    const index = kids.indexOf(node as never);
    if (index < 0) return null;
    path.unshift(index);
    node = parent;
  }
  return node && (node.rawTagName ?? "").toLowerCase() === "body" ? path : null;
}

// The block the user actually meant when they clicked deep inside a layout:
// for Framer that is the <section data-framer-name> wrapper, for Webflow and
// friends a plain <section>. Falling back to the deepest data-framer-name
// container keeps grouped content whole when a site lays out with divs only.
function selectionRegionFor(selected: unknown, body: unknown): unknown {
  let candidate: unknown = null;
  let node = selected as { parentNode?: unknown; rawTagName?: string } | null;
  while (node && node !== (body as never)) {
    const tag = (node.rawTagName ?? "").toLowerCase();
    if (tag === "section") return node;
    if (
      !candidate &&
      (node as { hasAttribute?: (name: string) => boolean }).hasAttribute?.("data-framer-name")
    )
      candidate = node;
    node = node.parentNode as typeof node;
  }
  if (!candidate && (body as { parentNode?: unknown }).parentNode) candidate = selected;
  return candidate;
}

// Selection exports the chosen region as a self-contained page. The runtime
// shell (scripts, styles, head) and the whole markup stay intact Ã¯Â¿Â½ frameworks
// (Framer hydration, Webflow's fluid typography and scroll interactions) only
// reproduce the live look when the exact same document and stylesheet cascade
// is present, so sibling branches are never removed. Every branch outside the
// region's ancestor chain is tagged data-weaver-hide and a build-time rule in
// the head hides them with display:none !important from the very first paint;
// a sibling-tagger in content-source.js re-applies it if a framework rebuilds
// nodes and hydration forgets the attribute.
function selectDocumentFragment(
  html: string,
  selector?: string,
): { html: string; region?: SelectedRegion } {
  if (!selector) return { html };
  try {
    const root = parseHtml(html, PARSE_OPTIONS);
    const selected = root.querySelector(selector);
    const body = root.querySelector("body");
    if (!selected || !body) return { html };

    const region = selectionRegionFor(selected, body) as typeof selected;
    region.setAttribute("data-weaver-selected", "true");
    body.setAttribute("data-weaver-selector", selector);

    const chain = new Set<typeof selected>();
    let node: typeof selected | null = region;
    while (node) {
      chain.add(node);
      if (node === body) break;
      node = node.parentNode as typeof selected | null;
    }

    // Every sibling branch outside the region's ancestor chain gets hidden,
    // never removed, so the layout and framework context stay identical.
    const tagBranch = (el: typeof selected) => {
      let cur: typeof selected | null = el;
      while (cur && cur !== body) {
        const parent = cur.parentNode as typeof selected | null;
        if (!parent) break;
        const kids = (parent.childNodes ?? []).filter(
          (child: { nodeType: number }) => child.nodeType === 1,
        ) as (typeof selected)[];
        for (const kid of kids) {
          if (kid === cur) continue;
          if (chain.has(kid)) continue;
          if (STRUCTURAL_TAGS.has((kid.rawTagName ?? "").toUpperCase())) continue;
          if (!kid.hasAttribute("data-weaver-hide")) {
            kid.setAttribute("data-weaver-hide", "true");
          }
        }
        cur = parent;
      }
    };
    tagBranch(region);

    return {
      html: root.toString(),
      region: { selector, path: elementChildPath(region) },
    };
  } catch {
    return { html };
  }
}

// All stylesheets collapse into one css/styles.css and all classic scripts into
// one js/main.js, so the archive never ships dozens of tiny files or inline code.
function consolidateBundle(html: string, assets: DownloadedAsset[]) {
  const decoder = new TextDecoder();
  const byPath = new Map(assets.map((asset) => [`/${asset.path}`, asset]));
  const root = parseHtml(html, PARSE_OPTIONS);
  const files: Record<string, string> = {};

  const cssParts: string[] = [];
  let cssAnchor: ReturnType<typeof parseHtml> | null = null;
  // Preload hints point at files that get merged away, so they are dropped first.
  for (const node of root.querySelectorAll(
    "link[rel=preload], link[rel=prefetch], link[rel=modulepreload]",
  )) {
    const href = node.getAttribute("href") ?? "";
    if (/^\/(css|js)\//.test(href)) node.remove();
  }
  for (const node of root.querySelectorAll("link[rel=stylesheet], style")) {
    let code = "";
    if (node.tagName === "STYLE") code = node.innerHTML ?? "";
    else {
      const href = node.getAttribute("href") ?? "";
      const asset = byPath.get(href);
      if (!asset) continue; // Remote stylesheet that could not be bundled stays untouched.
      code = decoder.decode(asset.bytes);
      const media = node.getAttribute("media");
      if (media && media !== "all") code = `@media ${media} {\n${code}\n}`;
    }
    // Labels use the origin URL: a local path here would keep the merged-away file alive during pruning.
    const label =
      node.tagName === "STYLE"
        ? "inline style"
        : (byPath.get(node.getAttribute("href") ?? "")?.original ?? "stylesheet");
    // An embedded <style> can carry a leading BOM/@charset from its toolchain;
    // merged mid-file that becomes an invalid CSS statement and makes Vite's CSS
    // pipeline reject the whole archive stylesheet. Strip it (UTF-8 is already
    // the archive default) so the merged file stays parseable.
    const part = code.replace(/^\uFEFF/, "").replace(/^\s*@charset\s+["'][^"']*["']\s*;/, "");
    if (part.trim()) cssParts.push(`/* ${label} */\n${part}`);
    if (!cssAnchor) {
      cssAnchor = node as never;
      node.replaceWith('<link rel="stylesheet" href="/css/styles.css">');
    } else node.remove();
  }
  if (cssParts.length) files["css/styles.css"] = cssParts.join("\n\n");

  const classicParts: string[] = [];
  const moduleParts: string[] = [];
  let scriptAnchor = false;
  for (const node of root.querySelectorAll("script")) {
    const type = (node.getAttribute("type") || "").toLowerCase();
    const isJs =
      type === "" ||
      type === "module" ||
      type === "text/javascript" ||
      type === "application/javascript";
    if (!isJs) continue; // JSON / hydration payloads must stay inline.
    const src = node.getAttribute("src") ?? "";
    let code = "";
    if (src) {
      const asset = byPath.get(src);
      if (!asset) continue; // Third-party script kept as its own remote tag.
      code = type === "module" ? `import ${JSON.stringify(src)};` : decoder.decode(asset.bytes);
    } else {
      code = node.innerHTML ?? "";
      if (!code.trim()) {
        node.remove();
        continue;
      }
    }
    if (type === "module") moduleParts.push(code);
    else
      classicParts.push(
        `/* ${byPath.get(src)?.original ?? "inline script"} */\ntry {\n${code}\n} catch (error) { console.error(error); }`,
      );
    if (!scriptAnchor) {
      scriptAnchor = true;
      node.replaceWith(
        `${classicParts.length || !moduleParts.length ? '<script src="/js/main.js" defer></script>' : ""}<script type="module" src="/js/main.mjs"></script>`,
      );
    } else node.remove();
  }
  if (classicParts.length) {
    const wrappedCode = `/* Script optimization for Live Server and development */
(function() {
  // Check if scripts already initialized
  if (window.__siteCloneInitialized) {
    console.log("[Site Clone] Scripts already initialized, skipping re-execution");
    return;
  }
  
  // Mark as initialized
  window.__siteCloneInitialized = true;
  
  // Execute scripts
  ${classicParts.join("\n\n")}
})();`;
    files["js/main.js"] = wrappedCode;
  }
  if (moduleParts.length) files["js/main.mjs"] = moduleParts.join("\n");

  let output = root.toString();
  // The classic bootstrap and the ES module entry must both ship, with the
  // classic script ahead: Nuxt/SvelteKit boots from an inline `window.__NUXT__`
  // (or equivalent) that the module graph reads at import time. The anchor is
  // the *first* script node, which for those sites is the module entry in the
  // head Ã¢â‚¬â€ before any classic parts have been collected Ã¢â‚¬â€ so retro-fit the
  // classic tag here when it was not part of the anchor replacement.
  if (!classicParts.length)
    output = output.replace('<script src="/js/main.js" defer></script>', "");
  else
    output = output.replace(
      /(?:<script src="\/js\/main\.js" defer><\/script>)?<script type="module" src="\/js\/main\.mjs"><\/script>/g,
      '<script src="/js/main.js" defer></script><script type="module" src="/js/main.mjs"></script>',
    );
  if (!moduleParts.length)
    output = output.replace('<script type="module" src="/js/main.mjs"></script>', "");
  return { html: output, files };
}

// Static archives use document-relative paths so the folder works from any mount point.
function relativizeLocalPaths(text: string, depth: number) {
  const prefix = "../".repeat(depth);
  return text.replace(
    /(^|["'`(\s,=])\/(css|js|assets)\//g,
    (_match, lead: string, folder: string) => `${lead}${prefix}${folder}/`,
  );
}

// Bundled module entries (js/main.mjs) keep the *origin* server-relative import
// specifiers the page's inline module script ships with (e.g. `/assets/root-Ã¢â‚¬Â¦js`),
// while the downloaded copies live at hashed local paths (`js/<hash>-root-Ã¢â‚¬Â¦js`).
// Point every specifier at the archived copy so hydration resolves offline and
// the prune pass can see the reference (and keeps the module).
function rewriteArchiveModuleImports(code: string, assets: DownloadedAsset[]) {
  const byPath = new Map<string, string>();
  for (const asset of assets) {
    if (!asset.textual) continue;
    try {
      const origin = new URL(asset.original).pathname.replace(/^\//, "");
      if (origin) byPath.set(origin, `/${asset.path}`);
    } catch {
      // Ignore unparseable originals.
    }
  }
  let output = code;
  for (const [specifier, local] of byPath) {
    if (specifier === local) continue;
    const rooted = `/${specifier}`;
    output = output.split(`"${rooted}"`).join(`"${local}"`);
    output = output.split(`'${rooted}'`).join(`'${local}'`);
    output = output.split(`\`${rooted}\``).join(`\`${local}\``);
    output = output.split(`"${specifier}"`).join(`"${local}"`);
    output = output.split(`'${specifier}'`).join(`'${local}'`);
    output = output.split(`\`${specifier}\``).join(`\`${local}\``);
  }
  return output;
}

const LOCAL_PATH_PATTERN =
  /(?:css|js|assets\/(?:images|videos|audio|fonts|icons|data))\/[A-Za-z0-9._-]+|assets\/[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}/g;

// React targets keep media under public/images, public/fonts, ... instead of the
// generic public/assets tree the static export uses. Applied to HTML, CSS, JS
// and the asset list together so every reference and every file agree.
const ASSET_FOLDER_MAP: [RegExp, string][] = [
  [/assets\/images\//g, "images/"],
  [/assets\/videos\//g, "videos/"],
  [/assets\/audio\//g, "audio/"],
  [/assets\/fonts\//g, "fonts/"],
  [/assets\/icons\//g, "icons/"],
  [/assets\/data\//g, "data/"],
];

function remapAssetPaths(text: string): string {
  let output = text;
  for (const [pattern, replacement] of ASSET_FOLDER_MAP)
    output = output.replace(pattern, replacement);
  return output;
}

const CHUNK_IMPORT = /import\(\s*(['"`])([^'"`]+)\1\s*\)/g;

// Only assets that the emitted code actually references are archived.
function pruneUnusedAssets(assets: DownloadedAsset[], entryTexts: string[]) {
  const decoder = new TextDecoder();
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const kept = new Map<string, DownloadedAsset>();
  const queue = [...entryTexts];

  while (queue.length) {
    const text = queue.shift() ?? "";
    for (const match of text.matchAll(LOCAL_PATH_PATTERN)) {
      const asset = byPath.get(match[0]);
      if (!asset || kept.has(asset.path)) continue;
      kept.set(asset.path, asset);
      if (asset.textual) queue.push(decoder.decode(asset.bytes));
    }
  }
  // Runtime-referenced media (filmstrip frames etc.) has no static reference in
  // the emitted text; its alias is the only proof it is archived on purpose.
  for (const asset of assets) {
    if ((asset.aliases?.length ?? 0) > 0 && !kept.has(asset.path)) kept.set(asset.path, asset);
  }

  return [...kept.values()];
}

// Prettier on multi-megabyte bundles is what pushed exports past the worker CPU
// budget; larger files fall back to a cheap readable reformat.
const FORMAT_MAX_BYTES = 700_000;

function fallbackCss(code: string) {
  return code
    .replace(/\s*\{\s*/g, " {\n  ")
    .replace(/;\s*/g, ";\n  ")
    .replace(/\s*\}\s*/g, "\n}\n\n")
    .replace(/\n\s+\n/g, "\n");
}

// Every text file in the ZIP is pretty-printed; nothing ships minified.
async function formatSource(path: string, code: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const parser =
    extension === "css"
      ? "css"
      : extension === "html"
        ? "html"
        : ["js", "mjs", "jsx", "ts", "tsx"].includes(extension)
          ? "babel"
          : extension === "json"
            ? "json"
            : undefined;
  if (!parser) return code;
  if (code.length > FORMAT_MAX_BYTES) return parser === "css" ? fallbackCss(code) : code;
  try {
    return await prettier.format(code, {
      parser,
      plugins: [parserBabel, parserEstree, parserPostcss, parserHtml],
      printWidth: 120,
      htmlWhitespaceSensitivity: "ignore",
    });
  } catch {
    return parser === "css" ? fallbackCss(code) : code;
  }
}

// The whole screen turns black if the site boot script dies before it removes
// the fixed intro/transition overlays (Framer hides content behind solid divs
// like .intro-bg until JS animates them away). This inline net unblocks the
// page when something breaks. Full-screen name layers (.name-layer) are not
// touched: many sites keep the hero name visible in them permanently.
const SAFETY_SCRIPT_RAW = `(function () {
  var ran = false;
  var liftRan = false;
  function unhide() {
    if (ran) return;
    ran = true;
    try {
      var selectors = [".intro-bg", ".transition-panel", ".page-fade"];
      var found = document.getElementById("intro-bg") || document.getElementById("transition-panel");
      if (!found) {
        for (var i = 0; i < selectors.length; i++) {
          if (document.querySelector(selectors[i])) { found = true; break; }
        }
      }
      if (!found) return;
      for (var j = 0; j < selectors.length; j++) {
        var nodes = document.querySelectorAll(selectors[j]);
        for (var k = 0; k < nodes.length; k++) nodes[k].style.setProperty("display", "none", "important");
      }
      var wrap = document.getElementById("scroll-wrap");
      if (wrap) { wrap.style.setProperty("opacity", "1"); wrap.style.setProperty("visibility", "visible"); }
    } catch (ignored) {}
  }
  // Generic stuck-overlay lifter. Some sites (React/Remix, hand-rolled) cover
  // the whole viewport with a fixed intro/curtain/splash <div> (z-index high,
  // solid background or a <canvas>) that only their own scroll/gasp timeline
  // removes. The clone has no such timeline, so if the overlay is still pinned
  // over the screen long after boot it is lifted. Only position:fixed elements
  // that block the whole viewport qualify Ã¢â‚¬â€ sticky/absolute sections (pinned
  // cards, parallax heroes) are never touched.
  function liftStuckOverlays() {
    if (liftRan) return;
    liftRan = true;
    try {
      var W = window.innerWidth, H = window.innerHeight;
      if (!W || !H) return;
      if (window.__siteClonerOverlays !== undefined) return;
      var els = document.querySelectorAll("body *");
      var lifted = false;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "LINK" || tag === "META") continue;
        var cs = getComputedStyle(el);
        if (cs.position !== "fixed") continue;
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (Number(cs.opacity || 1) === 0) continue;
        var rect = el.getBoundingClientRect();
        if (rect.width < W * 0.9 || rect.height < H * 0.9) continue;
        if (Math.abs(rect.top) > 2 || Math.abs(rect.left) > 2) continue;
        var z = parseInt(cs.zIndex, 10);
        if (!isFinite(z) || z < 20) continue;
        var bg = cs.backgroundColor;
        var bgOpaque = !!bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
        var hasCanvas = !!el.querySelector("canvas");
        var hasVisible = (el.innerText || "").trim().length > 0;
        if (!bgOpaque && !hasCanvas && !hasVisible) continue;
        // Persistent name/preloader layers may legitimately stay visible.
        if (el.closest("#name-layer, .name-layer, #preloader-luke, #preloader-logo, #preloader-content, #preloader-dot")) continue;
        // The intro curtain lifts itself roughly 5.5s after boot (its lottie
        // intro, titles and fade run on their own timeline). Lifting it here
        // would freeze the title mid animation, so skip it and let it finish.
        if (el.closest(".intro-curtain, .curtain-title, .curtain-desc") || el.querySelector(".curtain-title, .curtain-desc"))
          continue;
        // Only lift elements that still fully cover the viewport as seen by the
        // user (i.e. they were not animated away on their own).
        el.style.setProperty("display", "none", "important");
        lifted = true;
      }
      if (lifted) {
        var wrap = document.getElementById("scroll-wrap");
        if (wrap) { wrap.style.setProperty("opacity", "1"); wrap.style.setProperty("visibility", "visible"); }
        window.__siteClonerOverlays = true;
      }
    } catch (ignored) {}
  }
  window.addEventListener("error", function () { setTimeout(unhide, 2000); setTimeout(liftStuckOverlays, 2500); });
  window.addEventListener("unhandledrejection", function () { setTimeout(unhide, 2000); setTimeout(liftStuckOverlays, 2500); });
  setTimeout(function () {
    unhide();
    // Layout guard: animated titles are often white-space:nowrap with a huge
    // font, so any longer replacement text blows out horizontally (broken
    // layout). Wrap text that overflows its container so edits stay contained.
    try {
      var all = document.querySelectorAll("body *");
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "CANVAS" || tag === "SVG" || tag === "NOSCRIPT") continue;
        // Skip the hero name layer: its oversized lettering intentionally
        // spans the whole viewport and its per-character layout is derived,
        // so forcing wrap would scatter the letters vertically.
        if (el.closest("#preloader-content, #preloader-logo, #preloader-luke, #preloader-baffait, #preloader-dot, #name-layer, .name-layer")) continue;
        var cs = getComputedStyle(el);
        if (cs.whiteSpace !== "nowrap" || cs.writingMode !== "horizontal-tb") continue;
        if (el.scrollWidth > Math.min(el.clientWidth, window.innerWidth) + 40) {
          el.style.whiteSpace = "normal";
          el.style.overflowWrap = "anywhere";
        }
      }
    } catch (ignored2) {}
    // The curtain/loader overlay is given one extra beat to animate away on its
    // own before being lifted for good.
    setTimeout(liftStuckOverlays, 1200);
  }, 3000);
  // The intro curtain normally slides away ~5.5s in. If its lottie never loads
  // the titles stay frozen at opacity 0, so force the whole curtain off at 8s.
  setTimeout(function () {
    try {
      var curtain = document.querySelector(".intro-curtain, [class*='curtain'], .curtain-title, .curtain-desc");
      var holder = curtain ? curtain.closest("div, main, section") || curtain : null;
      if (!holder) return;
      var cs = getComputedStyle(holder);
      var rect = holder.getBoundingClientRect();
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity || 1) === 0) return;
      if (rect.width < window.innerWidth * 0.7 || rect.height < window.innerHeight * 0.7) return;
      holder.style.setProperty("display", "none", "important");
    } catch (ignoredCurtain) {}
  }, 8000);
})();
`;

const SAFETY_SCRIPT = `<script data-site-cloner-safety>
${SAFETY_SCRIPT_RAW}
</script>`;

// Some Nuxt layouts mount the full page twice into #__nuxt (a leftover from the
// language-switch / transition machinery that the live site trims after boot).
// Each copy re-pins its fixed layers Ã¢â‚¬â€ hero titles, USP cards, CTAs Ã¢â‚¬â€ so while
// the real site shows one pinned layer per section, the exported archive paints
// them twice as a stuck, doubled heap in the middle of the screen. The exported
// page needs the same trim, applied once hydration has inserted both copies.
const DEDUP_SCRIPT_RAW = `(function () {
  var tries = 0;
  function dedupe() {
    var nuxt = document.getElementById("__nuxt");
    var changed = false;

    if (nuxt) {
      // 1. Multiple <main> anywhere inside __nuxt (e.g. wrapped in multiple div.container):
      var mains = nuxt.querySelectorAll("main");
      if (mains.length >= 2) {
        function getTopChild(el) {
          while (el && el.parentElement && el.parentElement !== nuxt) {
            el = el.parentElement;
          }
          return el && el.parentElement === nuxt ? el : null;
        }
        var keptRoot = getTopChild(mains[0]);
        for (var i = 1; i < mains.length; i++) {
          var dupRoot = getTopChild(mains[i]);
          if (dupRoot && dupRoot !== keptRoot) {
            dupRoot.remove();
            changed = true;
          }
        }
      }

      // 2. Identical top-level containers inside __nuxt:
      if (!changed && nuxt.children.length >= 2) {
        var c0 = nuxt.children[0];
        var c1 = nuxt.children[1];
        if (c0 && c1 && c0.tagName === c1.tagName && c0.className === c1.className) {
          var h0 = c0.getBoundingClientRect().height;
          var h1 = c1.getBoundingClientRect().height;
          if (h0 > 300 && h1 > 300) {
            c1.remove();
            changed = true;
          }
        }
      }

      // 3. Classic direct header/main/footer deduplication:
      if (!changed) {
        var keptMain = false, keptHeader = false, keptFooter = false;
        var nodes = Array.prototype.slice.call(nuxt.children);
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          var tag = el.tagName;
          var cls = el.getAttribute("class") || "";
          var isSkip = tag === "A" && /skip[- ]link/i.test(cls);
          if (tag === "MAIN") {
            if (keptMain) { el.remove(); changed = true; }
            else keptMain = true;
          } else if (tag === "HEADER") {
            if (keptHeader) { el.remove(); changed = true; }
            else keptHeader = true;
          } else if (tag === "FOOTER") {
            if (keptFooter) { el.remove(); changed = true; }
            else keptFooter = true;
          } else if (isSkip && keptHeader) {
            el.remove(); changed = true;
          }
        }
      }
    } else {
      // 4. Duplicate <main> elements anywhere in document
      var allMains = document.querySelectorAll("main");
      if (allMains.length >= 2) {
        for (var k = 1; k < allMains.length; k++) {
          allMains[k].remove();
          changed = true;
        }
      }
    }

    if (changed) {
      try {
        if (window.lenis && window.lenis.resize) window.lenis.resize();
        window.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("scroll"));
        if (window.ScrollTrigger && window.ScrollTrigger.refresh) window.ScrollTrigger.refresh();
      } catch (ignored) {}
    }
    return changed;
  }
  dedupe();
  var timer = setInterval(function () {
    if (dedupe() || ++tries > 25) clearInterval(timer);
  }, 200);
})();
`;

const DEDUP_SCRIPT = `<script data-site-cloner-dedupe>
${DEDUP_SCRIPT_RAW}
</script>`;

/**
 * Make the exported HTML user-editable instead of a script-driven mirror:
 * - Framer's i18n runtime overwrites any element carrying data-i18n / data-i18n-attr /
 *   data-i18n-title from its embedded dictionary on load, so edits to the text never
 *   stick and the page silently switches language. Stripping the attributes makes the
 *   HTML text the single source of truth.
 * - Video preloads typed as images (as="image") force a multi-MB download on every
 *   cold load and log console warnings; they are dropped, videos load on demand with
 *   Range support from serve.mjs.
 * - When `safety` is set (static target), the blank-screen net is injected before
 *   </body>. React targets get their own copy in the generated Vite shell instead.
 */
function makeEditableHtml(html: string, safety: boolean): string {
  const root = parseHtml(html, PARSE_OPTIONS);

  // Only strip an i18n attribute when the content it would fill already exists
  // in the HTML. Otherwise the element would go permanently blank for sites
  // whose dictionary is the only source of that text.
  for (const el of root.querySelectorAll("[data-i18n]")) {
    if ((el.text ?? "").trim()) el.removeAttribute("data-i18n");
  }
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    const targets = (el.getAttribute("data-i18n-attr") ?? "")
      .split("|")
      .map((pair) => (pair.split(":")[0] ?? "").trim())
      .filter(Boolean);
    const allSet =
      targets.length > 0 && targets.every((attr) => (el.getAttribute(attr) ?? "").trim() !== "");
    if (allSet || targets.length === 0) el.removeAttribute("data-i18n-attr");
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const title = root.querySelector("title");
    if (title && (title.text ?? "").trim()) el.removeAttribute("data-i18n-title");
  }

  for (const link of root.querySelectorAll('link[rel="preload"],link[rel="prefetch"]')) {
    const href = (link.getAttribute("href") ?? "").toLowerCase();
    // Media preloads (video/audio/images) are dropped: videos were mistyped as
    // images (forced download + console warning), and image preloads are usually
    // cache-busted at runtime, so they only cost bandwidth. Fonts are kept.
    if (/\.(mp4|webm|mov|mp3|m4a|ogg|wav|jpe?g|png|webp|avif|gif|svg)([?#:;]|$)/.test(href))
      link.remove();
  }

  // Framer renders the visible text of many elements purely from data-chr /
  // data-chr-contact / data-chr-footer attributes: the element itself is empty and
  // the runtime injects per-character spans on load. Editing the attribute is
  // unintuitive and longer text duplicates/breaks the char layout, so the text is
  // baked into the element as plain content and the attributes removed. The
  // char-flip hover animation is lost; the text becomes a normal, editable node.
  for (const el of root.querySelectorAll("[data-chr-contact],[data-chr-footer],[data-chr]")) {
    const text =
      el.getAttribute("data-chr") ??
      el.getAttribute("data-chr-contact") ??
      el.getAttribute("data-chr-footer");
    el.removeAttribute("data-chr-contact");
    el.removeAttribute("data-chr-footer");
    el.removeAttribute("data-chr");
    if (text && !(el.text ?? "").trim()) el.textContent = text;
  }

  // Keep the intro name markup exactly as the site shipped it. Some sites render
  // the hero name as separate styled nodes (#preloader-logo "L" + #preloader-luke
  // "uke" + #preloader-baffait " Baffait" + #preloader-dot ".") that the runtime
  // positions and re-splits per character with per-node fonts. Merging them would
  // change the typeface and drop the first letter/dot, so they are left untouched.

  const body = root.querySelector("body");
  if (safety && body) body.insertAdjacentHTML("beforeend", SAFETY_SCRIPT + DEDUP_SCRIPT);

  return root.toString();
}

// The archived runtime (hashed chunk JS under js/) drives the animations and
// effects, so it must stay for the page to behave like the real site. That
// runtime re-writes most text on hydration, so an inline overlay records the
// text the author edited in index.html BEFORE the runtime runs and re-applies
// it once the runtime settles: user text wins, everything else keeps animating.
function injectStaticTextOverlay(html: string): string {
  const editable = buildNuxtEditable(html, false);
  if (!editable) return html;
  const texts = nuxtTextRegions(editable);
  if (!texts.length) return html;
  const idx = html.lastIndexOf("</body>");
  if (idx < 0) return html;
  const overlay = `<script data-site-cloner-text-overlay>
(function () {
  var NUXT_TEXTS = ${JSON.stringify(texts)};

  // Whitespace-insensitive compare: the archived SSR text is minified while the
  // emitted index.html is re-indented, so only REAL content edits count.
  function norm(s) {
    return (s || "").replace(/\\s+/g, " ").trim();
  }

  // Resolves the text node under \`root\` at element-chain \`path\`, sitting right
  // before the \`index\`-th element child of the target parent (comments and
  // whitespace-only text nodes are skipped, matching how they were collected).
  function locateText(root, path, index) {
    var node = root;
    for (var i = 0; i < path.length; i++) {
      var child = node.children[path[i]];
      if (!child) return null;
      node = child;
    }
    var elementsSeen = 0;
    var nodes = node.childNodes;
    for (var j = 0; j < nodes.length; j++) {
      var c = nodes[j];
      if (c.nodeType === 1) {
        if (elementsSeen === index) return null;
        elementsSeen++;
      } else if (c.nodeType === 3 && c.textContent && c.textContent.trim()) {
        if (elementsSeen === index) return c;
      }
    }
    return null;
  }

  // Record the text the author wrote in index.html BEFORE the site's own scripts
  // run over the DOM; only nodes whose content actually changed are tracked.
  var tracked = [];
  var nuxt = document.getElementById("__nuxt");
  if (nuxt) {
    for (var s = 0; s < NUXT_TEXTS.length; s++) {
      var entry = NUXT_TEXTS[s];
      var root = nuxt.querySelector(entry.selector);
      if (!root) continue;
      for (var t = 0; t < entry.texts.length; t++) {
        var region = entry.texts[t];
        var node = locateText(root, region.path, region.index);
        if (!node || !node.textContent || !node.textContent.trim()) continue;
        if (norm(node.textContent) === norm(region.text)) continue;
        tracked.push({ node: node, region: region, root: root, selector: entry.selector, authored: node.textContent });
      }
    }
  }

  // The archived runtime keeps re-rendering after boot, reverting the edited
  // text; every DOM mutation (de-bounced) re-applies the authored copy. Nodes
  // the runtime re-created are re-located by path before re-applying.
  // Re-resolves an entry against the live DOM: the runtime may replace whole
  // sections, so the root is re-queried by selector on every pass.
  function resolve(t) {
    var sources = [nuxt, document.body];
    for (var r = 0; r < sources.length; r++) {
      if (!sources[r]) continue;
      var root = sources[r].querySelector(t.selector);
      if (root && root.isConnected) {
        var node = locateText(root, t.region.path, t.region.index);
        if (node && node.isConnected) return { root: root, node: node };
      }
    }
    return null;
  }

  // Applies the authored (edited) text to every tracked region. Only touches
  // nodes whose content differs, so an authored write that triggers the
  // observer results in a no-op and the loop settles immediately.
  function apply() {
    for (var i = 0; i < tracked.length; i++) {
      try {
        var t = tracked[i];
        var hit = t.node && t.node.isConnected ? t : resolve(t);
        if (!hit) continue;
        t.root = hit.root;
        t.node = hit.node;
        if (t.node.textContent !== t.authored) {
          t.node.textContent = t.authored;
        }
      } catch (_e) {}
    }
  }
  var observer = null;
  if (window.MutationObserver) {
    observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  window.addEventListener("load", apply);
  window.setTimeout(apply, 300);
  window.setInterval(apply, 1200);
})();
</script>
`;
  return html.slice(0, idx) + "\n" + overlay + html.slice(idx);
}

// Archived single-page runtimes (React Router / Remix, several Vite SPAs) branch
// on `location.pathname` to decide the active route Ã¢â‚¬â€ e.g. maximatherapy's root
// route plays its intro curtain timeline only when `pathname === "/"`. Opening
// the export as `Ã¢â‚¬Â¦/index.html` (Live Server "Go Live" with the file, any static
// host that keeps the filename) makes the pathname `Ã¢â‚¬Â¦/index.html`, so the home
// route never matches, the curtain never lifts and every hero section stays
// blank. Rewrite the trailing `/index.html` back to `/` with history.replaceState
// BEFORE the runtime scripts parse, so the clone behaves identically whether it
// is opened at `/` or `/index.html`. Runs first in <head>, is a no-op when the
// pathname already lacks the filename, and preserves query/hash so in-page links
// keep working.
const STATIC_PATH_SHIM = `<script data-site-cloner-path-shim>(function () {
  try {
    var loc = window.location;
    var path = loc.pathname;
    var normalized = path.replace(/\\/index\\.html?$/i, "/").replace(/\\/index\\.html?\\//i, "/");
    if (normalized === path) return;
    var target = normalized + (loc.search || "") + (loc.hash || "");
    window.history.replaceState(window.history.state, "", target);
  } catch (ignored) {}
})();</script>`;

// Static index.html keeps relative refs (css/styles.css, js/...). On sub-routes
// like /programs/3-to-18 a browser would resolve those against the route, so pin
// a <base href="/"> to keep them loading from the root no matter what path the
// archived router serves the shell from. The path shim must sit ahead of the base
// tag and every origin script so the runtime reads a normalized pathname.
function injectStaticBaseTag(html: string): string {
  const withShim = html.replace(
    /<head([^>]*)>/i,
    (match, attrs: string) =>
      `<head${attrs}>\n  ${STATIC_PATH_SHIM}${
        /<base\b/i.test(html) ? "" : '\n  <base href="/" />'
      }`,
  );
  if (/<head([^>]*)>/i.test(html)) return withShim;
  return /<base\b/i.test(html) ? html : `${STATIC_PATH_SHIM}${html}`;
}

// Split the merged stylesheet into per-section files for the static export, the
// way a hand-authored project keeps global/header/hero/sections/footer CSS apart.
//
// Cascade safety: CSS resolves conflicts by the ORDER rules appear in the
// document, and separate <link>s load in tag order, so a semantic regroup (moving
// every `.footer` rule into footer.css) would shift rules past each other and
// change computed styles. To keep the output pixel-identical, each block is
// classified by section and only ADJACENT same-section blocks are coalesced into
// a file (run-length grouping). The concatenated file order therefore reproduces
// the original order exactly, while the file names still read per-section.
const CSS_SECTION_RULES: [RegExp, string][] = [
  [/\b(header|nav|menu|topbar|top-bar|navbar)\b/i, "header"],
  [/\b(hero|intro|banner|masthead)\b/i, "hero"],
  [/\b(footer|credits|colophon)\b/i, "footer"],
  [
    /\b(section|about|work|gallery|projects|awards|skills|services|contact|faq|testimonial)\b/i,
    "sections",
  ],
];

function classifyCssBlock(block: string): string {
  const selector = block.slice(0, Math.max(0, block.search(/[{]/))).trim();
  for (const [pattern, name] of CSS_SECTION_RULES) if (pattern.test(selector)) return name;
  return "global";
}

// Splits a CSS string into ordered top-level statements (rules, at-rules with a
// block, and lone at-statements like @charset/@import). Strings and comments are
// skipped so a `{`/`}` inside them never breaks the scan.
function splitCssBlocks(css: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = css.length;
  while (i < n) {
    const ch = css[i]!;
    const next = css[i + 1];
    if (ch === "/" && next === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (css[j] === "\\") {
          j += 2;
          continue;
        }
        if (css[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push(css.slice(start, i + 1).trim());
        start = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      // A lone at-statement (@charset, @import url(...);).
      const piece = css.slice(start, i + 1).trim();
      if (/^@/.test(piece)) blocks.push(piece);
      start = i + 1;
    }
    i += 1;
  }
  const tail = css.slice(start).trim();
  if (tail) blocks.push(tail);
  return blocks.filter(Boolean);
}

// Rewrites the static export so css/styles.css becomes several ordered,
// per-section stylesheets and the <link> in index.html points at all of them.
function splitStaticStylesheets(files: Record<string, Uint8Array>): void {
  const merged = files["css/styles.css"];
  const indexHtml = files["index.html"];
  if (!merged || !indexHtml) return;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const blocks = splitCssBlocks(decoder.decode(merged));
  if (blocks.length < 8) return;

  // Cut the block list into a handful of CONTIGUOUS chunks of roughly equal size,
  // so the concatenation order is untouched (cascade-safe) yet the archive has a
  // small set of readable files instead of one monolith. Each chunk is named for
  // the section its selectors mention most, so the names stay meaningful.
  const TARGET_CHUNKS = Math.min(6, Math.max(2, Math.round(blocks.length / 40)));
  const perChunk = Math.ceil(blocks.length / TARGET_CHUNKS);
  const chunks: string[][] = [];
  for (let i = 0; i < blocks.length; i += perChunk) chunks.push(blocks.slice(i, i + perChunk));
  if (chunks.length < 2) return;

  const usedNames = new Set<string>();
  const links: string[] = [];
  const emitted: Record<string, string> = {};
  chunks.forEach((chunk, index) => {
    const tally = new Map<string, number>();
    for (const block of chunk) {
      const section = classifyCssBlock(block);
      tally.set(section, (tally.get(section) ?? 0) + block.length);
    }
    let name = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "global";
    // The first chunk holds the reset/typography/font-face base: always "global".
    if (index === 0) name = "global";
    let fileName = `${name}.css`;
    for (let i = 2; usedNames.has(fileName); i += 1) fileName = `${name}-${i}.css`;
    usedNames.add(fileName);
    emitted[`css/${fileName}`] = `${chunk.join("\n\n")}\n`;
    links.push(`    <link rel="stylesheet" href="css/${fileName}" />`);
  });

  // Every block landed in exactly one file, in original order: loading the links
  // top-to-bottom concatenates them to the exact original stylesheet.
  delete files["css/styles.css"];
  for (const [rel, code] of Object.entries(emitted)) files[rel] = encoder.encode(code);

  const html = decoder.decode(indexHtml);
  const replaced = html.replace(
    /\s*<link[^>]*rel=["']stylesheet["'][^>]*href=["'][^"']*css\/styles\.css["'][^>]*>/i,
    `\n${links.join("\n")}`,
  );
  if (replaced !== html) files["index.html"] = encoder.encode(replaced);
}

// Raw static HTML paints the archived SSR markup the instant the browser has it,
function staticFiles(html: string, source: URL) {
  return {
    "index.html": strToU8(html),
    "serve.mjs": strToU8(
      `import { createServer } from "node:http";\nimport { readFile, stat } from "node:fs/promises";\nimport { dirname, extname, join, normalize } from "node:path";\nimport { fileURLToPath } from "node:url";\n\nconst root = dirname(fileURLToPath(import.meta.url));\nconst port = Number(process.env.PORT || 5000);\nconst types = {\n  ".html": "text/html; charset=utf-8",\n  ".css": "text/css; charset=utf-8",\n  ".js": "text/javascript; charset=utf-8",\n  ".mjs": "text/javascript; charset=utf-8",\n  ".json": "application/json",\n  ".svg": "image/svg+xml",\n  ".png": "image/png",\n  ".jpg": "image/jpeg",\n  ".jpeg": "image/jpeg",\n  ".gif": "image/gif",\n  ".webp": "image/webp",\n  ".avif": "image/avif",\n  ".ico": "image/x-icon",\n  ".mp4": "video/mp4",\n  ".webm": "video/webm",\n  ".mp3": "audio/mpeg",\n  ".m4a": "audio/mp4",\n  ".ogg": "audio/ogg",\n  ".wav": "audio/wav",\n  ".woff": "font/woff",\n  ".woff2": "font/woff2",\n  ".ttf": "font/ttf",\n  ".otf": "font/otf",\n};\n// Media and everything under assets/ never changes during development, so\n// browsers serve them from cache on refresh (no lag). The HTML that holds the\n// content plus CSS/JS are always revalidated so edits show up immediately.\nconst IMMUTABLE_RE = /\\.(png|jpe?g|gif|webp|avif|ico|mp4|webm|mp3|m4a|ogg|wav|woff2?|ttf|otf|svg)$|^assets\\//;\n\ncreateServer(async (request, response) => {\n  const name = decodeURIComponent(new URL(request.url, "http://localhost").pathname);\n  const rel = normalize(name === "/" ? "/index.html" : name).replace(/\\\\\\\\/g, "/").replace(/^\\/+/, "");\n  const notFound = () => {\n    response.writeHead(404, { "content-type": "text/plain" });\n    response.end("Not found");\n  };\n  if (!rel || rel.includes("..") || /^[A-Za-z]:\\//.test(rel)) return notFound();\n  const file = join(root, rel);\n  try {\n    const info = await stat(file);\n    if (!info.isFile()) return notFound();\n    const type = types[extname(file).toLowerCase()] || "application/octet-stream";\n    const cacheControl = IMMUTABLE_RE.test(rel)\n      ? "public, max-age=31536000, immutable"\n      : "no-cache";\n    const range = /^bytes=(\\d*)-(\\d*)$/.exec(request.headers.range || "");\n    if (!range) {\n      const body = await readFile(file);\n      response.writeHead(200, {\n        "content-type": type,\n        "cache-control": cacheControl,\n        "accept-ranges": "bytes",\n        "content-length": info.size,\n      });\n      response.end(body);\n      return;\n    }\n    const start = range[1] === "" ? 0 : Number(range[1]);\n    const end = range[2] === "" ? info.size - 1 : Math.min(Number(range[2]), info.size - 1);\n    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {\n      response.writeHead(416, {\n        "content-type": "text/plain",\n        "content-range": \`bytes */\${info.size}\`,\n      });\n      response.end("Range not satisfiable");\n      return;\n    }\n    const body = (await readFile(file)).subarray(start, end + 1);\n    response.writeHead(206, {\n      "content-type": type,\n      "cache-control": cacheControl,\n      "accept-ranges": "bytes",\n      "content-range": \`bytes \${start}-\${end}/\${info.size}\`,\n      "content-length": body.length,\n    });\n    response.end(body);\n  } catch {\n    if (!extname(rel)) {\n      try {\n        const bodyIndex = await readFile(join(root, "index.html"));\n        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });\n        response.end(bodyIndex);\n        return;\n      } catch (ignoredIndex) {}\n    }\n    notFound();\n  }\n}).listen(port, () => console.log(\`Clone running on http://localhost:\${port}\`));\n`,
    ),
    "package.json": strToU8(
      JSON.stringify(
        {
          name: "site-clone-static",
          private: true,
          type: "module",
          scripts: { start: "node serve.mjs" },
        },
        null,
        2,
      ),
    ),
    "README.md": strToU8(
      `# ${source.hostname} - static clone\n\nA self-contained static export of ${source.origin}, kept pixel- and behaviour-identical\nto the live site (the original runtime scripts still run, so animations, scroll\neffects and responsive layout all keep working).\n\n## Quick start\n\n\`\`\`bash\nnpm start        # serves this folder on http://localhost:5000\n\`\`\`\n\nAny static host works too (Netlify, Vercel, GitHub Pages, nginx, ...): just\npublish the folder as-is. Serve it over HTTP - opening \`index.html\` from the file\nsystem will not resolve the scripts or media.\n\n## Project structure\n\n\`\`\`\n.\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ index.html          Semantic markup; edit page copy here\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ css/                Stylesheets, split per section and loaded in order:\nÃ¢â€â€š                       global.css, header.css, hero.css, sections.css, footer.css\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ js/\nÃ¢â€â€š   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ main.js         Classic scripts from the original site (animations, effects)\nÃ¢â€â€š   Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬ main.mjs        ES-module runtime from the original site\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ assets/\nÃ¢â€â€š   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ images/         Images (jpg, png, webp, avif, svg)\nÃ¢â€â€š   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ videos/         Video files (mp4, webm)\nÃ¢â€â€š   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ audio/          Audio files\nÃ¢â€â€š   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ fonts/          Web fonts\nÃ¢â€â€š   Ã¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ icons/          Favicons and icons\nÃ¢â€â€š   Ã¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬ data/           JSON/data fetched at runtime\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ serve.mjs           Zero-dependency local dev server (Range requests included)\nÃ¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬ package.json\n\`\`\`\n\n## Editing content\n\n- **Text** lives in \`index.html\`. Edit it there; keep the surrounding class names\n  and element structure intact so the archived scripts can still hydrate the page.\n  A small inline script remembers the text you changed and re-applies it right\n  after the site's own boot scripts run, so your copy sticks while everything\n  else keeps animating.\n- **Styles** live under \`css/\`. The files are loaded top-to-bottom, so later files\n  win ties - add your overrides to the last one (or a new file linked after them).\n  Change colours, spacing, fonts and media paths there.\n- **Media** sits under \`assets/\`. Swap a file in place (keep the same name) and\n  hard-refresh (Ctrl+Shift+R).\n\n## Notes\n\n- Some text is written by the original scripts at runtime (animated counters,\n  dates, canvas labels). Leave those, or adapt the matching code under \`js/\`.\n- A small inline safety script keeps the page from getting stuck behind a\n  full-screen intro overlay if a boot script fails.\n- Media under \`assets/\` is cached by the browser after the first load.\n- \`serve.mjs\` answers HTTP Range requests, so video scrubbing works.\n`,
    ),
  };
}

/**
 * Script srcs that point at the origin (http/https) inside the bundled HTML.
 * These are the rare cases downloadAssets could not fetch, so they stay as
 * remote references. The React output drops <head> wholesale, so they must be
 * re-attached at runtime to keep site behaviour (custom animation scripts,
 * embeds, ...) intact.
 */
function leftoverRemoteScripts(html: string): { src: string; module: boolean }[] {
  const out: { src: string; module: boolean }[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<script\b([^>]*?\bsrc=["'](https?:\/\/[^"']+)["'][^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const src = match[2] ?? "";
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, module: /type=["']module["']/i.test(attrs) });
  }
  return out;
}

function indentText(text: string, depth: number): string {
  const pad = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function buildLoadCalls(html: string, indent: string): string[] {
  const calls = [
    `loadScript("/js/main.js");`,
    `loadScript("/js/main.mjs", { module: true });`,
  ].filter((call, index) =>
    index === 0 ? html.includes("/js/main.js") : html.includes("/js/main.mjs"),
  );
  for (const { src, module: isModule } of leftoverRemoteScripts(html))
    calls.push(`loadScript(${JSON.stringify(src)}${isModule ? ", { module: true }" : ""});`);
  if (!calls.length) return [`${indent}// No bundled runtime scripts for this site.`];
  return calls.map((call) => `${indent}${call}`);
}

// Full-page mounting frameworks (Nuxt mounts the app into #__nuxt after reading
// a build manifest / payload) rebuild the whole page in their own root. When the
// consolidated bundle cannot boot (missing payload, wasm, i18n messages) it wipes
// the React-mirrored sections and shows the framework's error page instead, so
// the runtime is only attached when the payload it hydrates from is re-shipped
// (see nuxtPayloadTag).
function isFullPageRuntimeApp(html: string): boolean {
  return (
    /id=["']__nuxt["']/i.test(html) ||
    html.includes("__NUXT__") ||
    html.includes("/_payload.json") ||
    /\/_nuxt\//.test(html)
  );
}

// Nuxt SSR pages inline their whole state as
//   <script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">Ã¢â‚¬Â¦</script>
// The React conversion drops <script> wholesale, so without re-attaching it the
// archived runtime hydrates with an empty state: every query falls back to the
// origin API (CORS-blocked from the clone) and the framework renders its error
// page instead of the mirrored sections. Lift the tag out of the bundled document
// so both the shell HTML and the React mirror can carry it; `<` inside the JSON is
// escaped as \u003c so payload content can never terminate the tag early.
function nuxtPayload(html: string): { attrs: [string, string][]; json: string } | null {
  const match = /<script\b([^>]*\bid=["']__NUXT_DATA__["'][^>]*)>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  const attrs: [string, string][] = [];
  for (const attr of (match[1] ?? "").matchAll(
    /([^\s=]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g,
  )) {
    const name = (attr[1] ?? "").toLowerCase();
    if (!name || name === "<script") continue;
    attrs.push([name, attr[2] ?? attr[3] ?? ""]);
  }
  if (!attrs.some(([name]) => name === "type")) attrs.push(["type", "application/json"]);
  return { attrs, json: (match[2] ?? "").replace(/</g, "\\u003c") };
}

function payloadTagHtml(payload: { attrs: [string, string][]; json: string }): string {
  const attrs = payload.attrs.map(([name, value]) => ` ${name}="${value}"`).join("");
  return `<script${attrs}>${payload.json}</script>`;
}

type LayoutRef = { kind: "section" | "component"; name: string; filePath: string };

function stripModuleExt(filePath: string): string {
  return filePath.replace(/\.(jsx|tsx|ts|js)$/, "");
}

// Modules referenced directly by the composed page layout, in emission order.
// The layout normally only references sections, but wrapper markup that is
// inlined into the page can also reference extracted components, so both have
// to be imported there.
function referencedModules(
  sections: { name: string; filePath: string }[],
  components: { name: string; filePath: string }[],
  layout: string,
): LayoutRef[] {
  const referenced = new Set(
    [...layout.matchAll(/<([A-Z][A-Za-z0-9_]*)(?:[\s/>]|$)/g)].map((match) => match[1] ?? ""),
  );
  return [
    ...sections
      .filter((section) => referenced.has(section.name))
      .map((section) => ({
        kind: "section" as const,
        name: section.name,
        filePath: section.filePath,
      })),
    ...components
      .filter((component) => referenced.has(component.name))
      .map((component) => ({
        kind: "component" as const,
        name: component.name,
        filePath: component.filePath,
      })),
  ];
}

// TS projects need relaxed ambient types so mirrored site markup (CSS custom
// properties, arbitrary data-* attributes, unknown intrinsic elements) stays
// type-clean under `tsc`/`next build`.
const GLOBAL_DTS = `import "react";

declare module "react" {
  interface CSSProperties {
    [key: string]: any;
  }

  interface HTMLAttributes<T> {
    [key: string]: any;
  }

  interface SVGAttributes<T> {
    [key: string]: any;
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elementName: string]: any;
    }
  }
}
`;

function viteFiles(
  html: string,
  source: URL,
  sections: { name: string; filePath: string; code: string }[],
  layout: string,
  components: { name: string; filePath: string; code: string }[] = [],
  language: ExportLanguage = "jsx",
) {
  const ext = languageExtension(language);
  const codeExt = codeExtension(language);
  const isTs = language === "tsx";
  const loaders = buildLoadCalls(html, "    ");
  const payload = nuxtPayload(html);
  const payloadHtml = payload ? payloadTagHtml(payload) : "";
  // Boot the archived runtime only when it has the state it hydrates from;
  // without the payload a full-page framework wipes the mirrored sections.
  const bootRuntime = !isFullPageRuntimeApp(html) || payload != null;
  // Full-page frameworks overwrite the React-rendered text on hydration; track
  // the whole #__nuxt tree so edits in the section files can be re-applied.
  const textRegions = bootRuntime ? collectNuxtTextRegions(html) : [];
  const viteSectionList = sections
    .slice(0, 4)
    .map((s) => `${s.name}.${ext}`)
    .join(", ")
    .concat(sections.length > 4 ? ", ..." : "");
  const homeImports = referencedModules(sections, components, layout)
    .map((ref) =>
      ref.kind === "section"
        ? `import { ${ref.name} } from "../components/section/${ref.name}";`
        : `import { ${ref.name} } from "../components/ui/${ref.name}";`,
    )
    .join("\n");
  const devDependencies: Record<string, string> = {
    "@vitejs/plugin-react": "^4.3.4",
    // vite 5 ships a rollup 4 native addon (@rollup/*-*-msvc .node) that
    // Windows Smart App Control blocks by default ("Application Control policy
    // has blocked this file"). vite 4 uses pure-JS rollup 3, so the export
    // installs and runs on any Windows machine.
    vite: "^4.5.5",
  };
  if (isTs) {
    devDependencies["@types/react"] = "^18.3.12";
    devDependencies["@types/react-dom"] = "^18.3.1";
    devDependencies["typescript"] = "^5.6.3";
  }
  const utilsImport = isTs ? "../utils/loadScript" : "../utils/loadScript.js";
  const hookSource = bootRuntime
    ? nuxtTextHookSource(utilsImport, loaders, textRegions, collectInteriorAnchorsFromHtml(html))
    : `import { useEffect } from "react";

export function useSiteScripts() {
  useEffect(() => {}, []);
}
`;
  const files: Record<string, Uint8Array> = {
    "package.json": strToU8(
      JSON.stringify(
        {
          name: "site-clone-vite",
          private: true,
          type: "module",
          scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
          dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies,
        },
        null,
        2,
      ),
    ),
    "vite.config.js": strToU8(
      'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n',
    ),
    "index.html": strToU8(
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>Clone of ${source.hostname}</title>\n  </head>\n  <body>\n    <!-- Blank-screen net: if the site boot script dies the fixed intro overlays\n         never get removed and the page looks black. This unblocks it. -->\n    ${SAFETY_SCRIPT}\n    ${payloadHtml ? `${payloadHtml}\n    ` : ""}<div id="root"></div>\n    <script type="module" src="/src/main.${ext}"></script>\n  </body>\n</html>\n`,
    ),
    [`src/main.${ext}`]: strToU8(
      `import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")).render(<App />);
`,
    ),
    [`src/App.${ext}`]: strToU8(
      `import Home from "./pages/Home";
import { useSiteScripts } from "./hooks/useSiteScripts";

export default function App() {
  useSiteScripts();
  return <Home />;
}
`,
    ),
    [`src/pages/Home.${ext}`]: strToU8(
      `${homeImports}\n\nexport default function Home() {\n  return (\n    <>\n${indentText(layout, 3)}\n    </>\n  );\n}\n`,
    ),
    [`src/hooks/useSiteScripts.${codeExt}`]: strToU8(hookSource),
    [`src/utils/loadScript.${codeExt}`]: strToU8(
      isTs
        ? `export function loadScript(
  src: string,
  { module = false }: { module?: boolean } = {},
) {
  const script = document.createElement("script");
  if (module) script.type = "module";
  script.src = src;
  script.async = true;
  script.onerror = () => script.remove();
  document.body.appendChild(script);
}
`
        : `export function loadScript(src, { module = false } = {}) {
  const script = document.createElement("script");
  if (module) script.type = "module";
  script.src = src;
  script.async = true;
  script.onerror = () => script.remove();
  document.body.appendChild(script);
}
`,
    ),
    "src/assets/.gitkeep": strToU8(""),
    "README.md": strToU8(
      `# ${source.hostname} - Vite + React clone\n\nA React/Vite project mirroring ${source.origin}. Each page section is its own\ncomponent, composed in \`src/pages/Home.${ext}\`. The original site's runtime is\nshipped under \`public/js/\` and attached after mount, so the animations, scroll\neffects and responsive behaviour match the live site.\n\n## Quick start\n\n\`\`\`bash\nnpm install\nnpm run dev      # http://localhost:5173\nnpm run build    # production bundle in dist/\n\`\`\`\n\n## Project structure\n\n\`\`\`\nsrc/\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ main.${ext}                     App entry (mounts <App />)\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ App.${ext}                      Adds the site runtime, renders <Home />\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ pages/Home.${ext}               Composes the sections into the page\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ components/section/             One component per page section - edit here\nÃ¢â€â€š   ${viteSectionList}\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ components/ui/                  Reusable UI components (buttons, icons, badges)\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ hooks/useSiteScripts.${codeExt}  Loads the original runtime after mount\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ utils/loadScript.${codeExt}      Small DOM <script> loader\nÃ¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬ index.css                       All styles from the original site\npublic/\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ js/                             Original runtime scripts (main.js, main.mjs)\nÃ¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬ images | videos | audio | fonts | icons/   Media assets\n\`\`\`\n\n## Editing content\n\nEdit the section components in \`src/components/section/\`:\n\`\`\`${isTs ? "tsx" : "jsx"}\nexport function HeroSection() {\n  return (\n    <section className="hero">\n      <h1>Edit this text</h1>\n      <img src="/images/hero.jpg" alt="Hero" />\n    </section>\n  );\n}\n\`\`\`\n\n- **Text** is plain JSX - change it directly. Text that the original runtime\n  rewrites at load (counters, dates) is written by \`public/js/\`, not the JSX.\n- **Styles** live in \`src/index.css\` - change colours, spacing, fonts and media\n  paths there.\n- Sections import reusable pieces from \`../ui/\` so shared UI components stay in\n  one place.\n`,
    ),
  };

  if (isTs) {
    files["tsconfig.json"] = strToU8(
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2020",
            lib: ["ES2020", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "react-jsx",
            allowJs: true,
            strict: false,
            esModuleInterop: true,
            isolatedModules: true,
            skipLibCheck: true,
            noEmit: true,
            types: ["react"],
          },
          include: ["src", "global.d.ts"],
          exclude: ["node_modules", "dist"],
        },
        null,
        2,
      ),
    );
    files["global.d.ts"] = strToU8(GLOBAL_DTS);
  }

  for (const section of sections) {
    files[`src/${section.filePath}`] = strToU8(section.code);
  }

  for (const component of components) {
    files[`src/${component.filePath}`] = strToU8(component.code);
  }

  return files;
}

// Full-page mounting frameworks (Nuxt) rebuild the app into their own root
// (#__nuxt) from per-deploy manifests, so a React mirror of the SSR markup can
// never match what the bundle hydrates Ã¢â‚¬â€ mismatches abort the boot and wipe the
// sections. For those sites Vite and Next render the original SSR markup
// verbatim (one opaque string via dangerouslySetInnerHTML) and let the archived
// runtime hydrate it directly, restoring layout, transforms and animations.
function fullFidelityShellHtml(bundledHtml: string): string {
  const root = parseHtml(bundledHtml, PARSE_OPTIONS);
  const parts: string[] = [];
  const head = root.querySelector("head");
  if (head) {
    for (const node of head.querySelectorAll("script")) {
      if (!node.getAttribute("src")) parts.push(node.toString());
    }
  }
  const body = root.querySelector("body");
  if (body) parts.push(body.innerHTML ?? "");
  return parts.join("\n");
}

// Classic-first loader for the consolidated Nuxt runtime: js/main.js (classic
// scripts; sets window.__NUXT__) must run before js/main.mjs (ES modules; mounts
// the app against the injected SSR markup). Both are emitted under public/ for
// Vite/Next, so absolute /js/... paths resolve in dev and build alike.
const SITE_SHELL_SCRIPT_LOADER = `import { useEffect } from "react";

export function useSiteScripts() {
  useEffect(() => {
    const boot = () => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = "/js/main.mjs";
      script.async = true;
      script.onerror = () => script.remove();
      document.body.appendChild(script);
    };
    const script = document.createElement("script");
    script.src = "/js/main.js";
    script.async = true;
    script.onload = boot;
    script.onerror = boot;
    document.body.appendChild(script);
  }, []);
}
`;

// ---------------------------------------------------------------------------
// Editable Nuxt composition. Some Nuxt layouts survive being split into an
// editable component graph instead of one opaque shell string. The archived
// runtime hydrates the SSR DOM, so the composed tree still reproduces that DOM:
// root attributes verbatim, and the Vue fragment comments restored before the
// boot scripts run. Interiors are authored as readable JSX (the runtime owns
// everything that animates; editing the JSX keeps the same class/attribute
// contract). When the layout does not match (no #__nuxt or no main), the
// builders return null and the callers fall back to the opaque shell.
type NuxtEditableBlock = {
  key: string;
  name: string;
  tag: string;
  props: string;
  styleProp: string;
  inner: string;
  selector: string;
  // Readable JSX children (one entry per line, already indented) replacing the
  // opaque inner string, plus the fragment-comment anchors needing restoration.
  readable: string[];
  anchors: NuxtInteriorAnchor[];
  texts: NuxtTextRegion[];
};
type NuxtEditableAnchor = ["prepend" | "after", string, string];
type NuxtEditable = {
  support: NuxtEditableBlock[];
  anchors: NuxtEditableAnchor[];
  blocksBefore: NuxtEditableBlock[];
  blocksAfter: NuxtEditableBlock[];
  main: NuxtEditableBlock;
  wrap: NuxtEditableBlock | null;
  sections: NuxtEditableBlock[];
  cssVars: Array<{ selector: string; decl: string }>;
};

function nuxtBlockSelector(el: ParsedHTMLElement): string {
  const id = el.getAttribute("id");
  const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)[0];
  let sel = el.tagName.toLowerCase();
  if (id) sel += `#${id}`;
  else if (cls) sel += `.${cls}`;
  return sel;
}

const REACT_ATTR_ALIASES: Record<string, string> = {
  allowfullscreen: "allowFullScreen",
  autocapitalize: "autoCapitalize",
  autocorrect: "autoCorrect",
  autofocus: "autoFocus",
  autocomplete: "autoComplete",
  cellpadding: "cellPadding",
  cellspacing: "cellSpacing",
  charset: "charSet",
  colspan: "colSpan",
  contenteditable: "contentEditable",
  controlslist: "controlsList",
  crossorigin: "crossOrigin",
  datetime: "dateTime",
  disablepictureinpicture: "disablePictureInPicture",
  enctype: "encType",
  formaction: "formAction",
  formenctype: "formEncType",
  formmethod: "formMethod",
  formnovalidate: "formNoValidate",
  formtarget: "formTarget",
  frameborder: "frameBorder",
  hreflang: "hrefLang",
  httpequiv: "httpEquiv",
  ismap: "isMap",
  maxlength: "maxLength",
  minlength: "minLength",
  novalidate: "noValidate",
  playsinline: "playsInline",
  readonly: "readOnly",
  rowspan: "rowSpan",
  spellcheck: "spellCheck",
  srcdoc: "srcDoc",
  srcset: "srcSet",
  tabindex: "tabIndex",
  usemap: "useMap",
};

// Interior elements are authored as readable JSX (not one opaque __html string);
// the archived runtime hydrates that DOM, and the Vue comment markers React
// cannot render are re-inserted before boot at their exact SSR positions.
type NuxtInteriorAnchor = { path: number[]; index: number; token: string };

// A text node underneath a block root. The archived runtime re-writes most text
// on hydration, so any text the user edits in the JSX/HTML is captured before
// boot and re-applied right after it (path = element-child indexes down to the
// parent, index = element-child slot before which the text sits).
type NuxtTextRegion = { path: number[]; index: number; text: string };

function collectTextRegions(el: ParsedHTMLElement, path: number[], out: NuxtTextRegion[]): void {
  let elementIndex = 0;
  for (const child of el.childNodes) {
    if (child.nodeType === 1) {
      collectTextRegions(child as ParsedHTMLElement, [...path, elementIndex], out);
      elementIndex += 1;
    } else if (child.nodeType === 3) {
      const text = child.textContent ?? "";
      if (text.trim()) out.push({ path, index: elementIndex, text });
    }
  }
}

const SVG_ATTR_ALIASES: Record<string, string> = {
  // Keys are the dash-stripped lowercase attribute names; lookup also strips
  // dashes so `stroke-width` and `strokewidth` both resolve.
  viewbox: "viewBox",
  clippath: "clipPath",
  cliprule: "clipRule",
  fillopacity: "fillOpacity",
  fillrule: "fillRule",
  strokedasharray: "strokeDasharray",
  strokelinecap: "strokeLinecap",
  strokelinejoin: "strokeLinejoin",
  strokemiterlimit: "strokeMiterlimit",
  strokeopacity: "strokeOpacity",
  strokewidth: "strokeWidth",
  textanchor: "textAnchor",
  preserveaspectratio: "preserveAspectRatio",
  gradientunits: "gradientUnits",
  gradienttransform: "gradientTransform",
  spreadmethod: "spreadMethod",
  stopcolor: "stopColor",
  stopopacity: "stopOpacity",
  patternunits: "patternUnits",
  patterncontentunits: "patternContentUnits",
  patterntransform: "patternTransform",
  "xmlns:xlink": "xmlnsXLink",
  xlinkhref: "xlinkHref",
  fontfamily: "fontFamily",
  fontsize: "fontSize",
  fontweight: "fontWeight",
  textlength: "textLength",
  letterspacing: "letterSpacing",
  wordspacing: "wordSpacing",
  baselineshift: "baselineShift",
  dominantbaseline: "dominantBaseline",
  enablebackground: "enableBackground",
  paintorder: "paintOrder",
  vectoreffect: "vectorEffect",
  markerstart: "markerStart",
  markerend: "markerEnd",
  markermid: "markerMid",
  floodcolor: "floodColor",
  floodopacity: "floodOpacity",
  lightingcolor: "lightingColor",
  colorinterpolation: "colorInterpolation",
  colorinterpolationfilters: "colorInterpolationFilters",
  shaperendering: "shapeRendering",
  imagerendering: "imageRendering",
  pointerevents: "pointerEvents",
  startoffset: "startOffset",
};

const JSX_TAG_MAP: Record<string, string> = {
  clippath: "clipPath",
  lineargradient: "linearGradient",
  radialgradient: "radialGradient",
  foreignobject: "foreignObject",
  textpath: "textPath",
  feblend: "feBlend",
  fecolormatrix: "feColorMatrix",
  fegaussianblur: "feGaussianBlur",
  feimage: "feImage",
  femerge: "feMerge",
  femergenode: "feMergeNode",
  feoffset: "feOffset",
  feturbulence: "feTurbulence",
};

const JSX_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const JS_ATTR_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function cssStyleToJsxObject(css: string): string {
  const entries: string[] = [];
  for (const part of css.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const prop = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!prop || !value) continue;
    let key: string;
    if (prop.startsWith("--")) {
      key = JSON.stringify(prop);
    } else {
      const camel = prop.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      key = JS_ATTR_IDENTIFIER.test(camel) ? camel : JSON.stringify(camel);
    }
    const clean = value.replace(/\s*!important\s*$/, "").trim();
    entries.push(`${key}: ${JSON.stringify(clean)}`);
  }
  return `{ ${entries.join(", ")} }`;
}

const KNOWN_ATTRS = new Set([
  "id",
  "role",
  "href",
  "src",
  "srcset",
  "poster",
  "type",
  "integrity",
  "alt",
  "title",
  "lang",
  "value",
  "name",
  "placeholder",
  "target",
  "rel",
  "download",
  "loading",
  "width",
  "height",
  "cols",
  "rows",
  "size",
  "start",
  "span",
  "disabled",
  "checked",
  "required",
  "hidden",
  "method",
  "action",
  "min",
  "max",
  "step",
  "multiple",
  "controls",
  "autoplay",
  "loop",
  "muted",
  "preload",
  "d",
  "points",
  "fill",
  "stroke",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "stddeviation",
  "offset",
  ...Object.values(SVG_ATTR_ALIASES),
  ...Object.values(REACT_ATTR_ALIASES),
]);

// React skips the attribute type-check for most SSR junk; the whitelist above
// mirrors what React actually types. Anything else spreads through `as any` so
// the exact SSR DOM attribute survives (Vue relies on it during hydration).
type NuxtInteriorCtx = {
  dropSelected: boolean;
  selectDefaultValue?: string | undefined;
};

function collectSelectDefaultValue(el: ParsedHTMLElement): string | undefined {
  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue;
    const tag = (child as ParsedHTMLElement).tagName?.toLowerCase() ?? "";
    if (tag === "option") {
      const opt = child as ParsedHTMLElement;
      if (opt.getAttribute("selected") !== null) {
        const v = opt.getAttribute("value");
        return v !== null ? v : (opt.textContent ?? "").trim();
      }
    } else if (tag === "optgroup") {
      const nested = collectSelectDefaultValue(child as ParsedHTMLElement);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function nuxtInteriorProps(
  el: ParsedHTMLElement,
  isTs: boolean,
  ctx: NuxtInteriorCtx = { dropSelected: false },
): string {
  const tag = el.tagName?.toLowerCase() ?? "";
  const parts: string[] = [];
  if (tag === "select" && ctx.selectDefaultValue !== undefined) {
    parts.push(`defaultValue={${JSON.stringify(ctx.selectDefaultValue)}}`);
  }
  for (const [key, value] of Object.entries(el.attributes)) {
    if (
      key === "data-weaver-hide" ||
      key === "data-weaver-selected" ||
      key === "data-site-cloner-selector"
    )
      continue;
    const lower = key.toLowerCase();
    if (key === "class") {
      if (value) parts.push(`className={${JSON.stringify(value)}}`);
    } else if (key === "for") {
      parts.push(`htmlFor={${JSON.stringify(value)}}`);
    } else if (key === "style") {
      if (value) parts.push(`style={${cssStyleToJsxObject(value)}}`);
    } else if (lower === "inert") {
      // React 18 types inert as boolean yet warns on the boolean form; staying a
      // string writes inert="" without the warning, and Vue re-applies its own.
      parts.push(isTs ? `{...({ "inert": "" } as any)}` : `inert={""}`);
    } else if (lower === "tabindex") {
      parts.push(
        /^-?\d+$/.test(value) ? `tabIndex={${value}}` : `tabIndex={${JSON.stringify(value)}}`,
      );
    } else if (lower === "selected" && ctx.dropSelected) {
      // React warns on `selected` for <option>; the <select> parent carries the
      // choice as defaultValue instead.
      continue;
    } else if (lower === "checked" && tag === "input") {
      parts.push(`defaultChecked={true}`);
    } else if (lower === "value" && ["select", "input", "textarea"].includes(tag)) {
      if (tag === "select" && ctx.selectDefaultValue !== undefined) continue;
      if (value === "") continue;
      parts.push(`defaultValue={${JSON.stringify(value)}}`);
    } else if (lower === "value" && value === "") {
      // React warns when a select/input value matches no option; the archived
      // runtime re-applies its own control state after hydration anyway.
      if (["button"].includes(tag)) continue;
      parts.push(`value={${JSON.stringify(value)}}`);
    } else {
      let propKey = REACT_ATTR_ALIASES[lower] ?? key;
      const svgAlias = SVG_ATTR_ALIASES[lower] ?? SVG_ATTR_ALIASES[lower.replace(/-/g, "")];
      if (svgAlias) propKey = svgAlias;
      if (value === "") {
        parts.push(propKey);
      } else if (/^(data-|aria-)/.test(key) || KNOWN_ATTRS.has(propKey)) {
        parts.push(`${propKey}={${JSON.stringify(value)}}`);
      } else {
        parts.push(
          `{...({ ${JSON.stringify(propKey)}: ${JSON.stringify(value)} }${isTs ? " as any" : ""})}`,
        );
      }
    }
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function nuxtInteriorElement(
  el: ParsedHTMLElement,
  isTs: boolean,
  depth: number,
  isSvg: boolean,
  parentCtx: NuxtInteriorCtx = { dropSelected: false },
): string[] {
  const indent = "  ".repeat(depth);
  const tag = el.tagName?.toLowerCase() ?? "";
  if (!tag || ["script", "noscript", "template", "link", "meta", "title"].includes(tag)) return [];
  const jsxTag = JSX_TAG_MAP[tag] ?? tag;
  const ctx: NuxtInteriorCtx =
    tag === "select"
      ? { dropSelected: true, selectDefaultValue: collectSelectDefaultValue(el) }
      : parentCtx;
  const attrs = nuxtInteriorProps(el, isTs, ctx);
  const children = nuxtInteriorChildren(el, isTs, depth + 1, isSvg || tag === "svg", ctx);
  const open = `${indent}<${jsxTag}${attrs}`;
  if (JSX_VOID_TAGS.has(tag) || children.length === 0) return [`${open} />`];
  return [`${open}>`, ...children, `${indent}</${jsxTag}>`];
}

function nuxtInteriorChildren(
  el: ParsedHTMLElement,
  isTs: boolean,
  depth: number,
  isSvg: boolean,
  parentCtx: NuxtInteriorCtx = { dropSelected: false },
): string[] {
  const indent = "  ".repeat(depth);
  const out: string[] = [];
  for (const child of el.childNodes) {
    if (child.nodeType === 1) {
      out.push(...nuxtInteriorElement(child as ParsedHTMLElement, isTs, depth, isSvg, parentCtx));
    } else if (child.nodeType === 3) {
      const text = child.textContent ?? "";
      if (text.trim()) out.push(`${indent}{${JSON.stringify(text)}}`);
    }
  }
  return out;
}

function collectInteriorAnchors(
  el: ParsedHTMLElement,
  path: number[],
  out: NuxtInteriorAnchor[],
): void {
  let elementIndex = 0;
  for (const child of el.childNodes) {
    if (child.nodeType === 1) {
      collectInteriorAnchors(child as ParsedHTMLElement, [...path, elementIndex], out);
      elementIndex += 1;
    } else if (child.nodeType === 8) {
      out.push({ path, index: elementIndex, token: (child as { rawText?: string }).rawText ?? "" });
    }
  }
}

function collectInteriorAnchorsFromHtml(html: string): NuxtInteriorAnchor[] {
  const root = parseHtml(html, PARSE_OPTIONS);
  const host = root.querySelector("#__nuxt") ?? root.querySelector("body");
  if (!host) return [];
  const anchors: NuxtInteriorAnchor[] = [];
  collectInteriorAnchors(host, [], anchors);
  return anchors;
}

// SSR root styles that only set custom properties move into CSS: a stylesheet
// declaration gives Vue's hydration check the same computed value while the
// section root keeps no style prop (so it stays trimmed and React-safe).
function extractRootCssVars(
  el: ParsedHTMLElement,
  sel: string,
  cssVars: Array<{ selector: string; decl: string }>,
): { styleProp: string; attrs: Array<[string, string]> } {
  const attrs = Object.entries(el.attributes).filter(([key]) => key !== "style");
  const style = el.getAttribute("style");
  if (!style) return { styleProp: "", attrs };
  const decls: string[] = [];
  const kept: string[] = [];
  for (const part of style.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const col = trimmed.indexOf(":");
    if (col < 0) {
      kept.push(trimmed);
      continue;
    }
    const prop = trimmed.slice(0, col).trim();
    const value = trimmed.slice(col + 1).trim();
    if (prop.startsWith("--")) decls.push(`${prop}: ${value}`);
    else kept.push(trimmed);
  }
  if (decls.length) cssVars.push({ selector: sel, decl: decls.join("; ") });
  if (!kept.length) return { styleProp: "", attrs };
  const obj: Record<string, string> = {};
  for (const part of kept) {
    const col = part.indexOf(":");
    if (col > 0) {
      const prop = part
        .slice(0, col)
        .trim()
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      obj[prop] = part.slice(col + 1).trim();
    }
  }
  return { styleProp: `style={${JSON.stringify(obj)}}`, attrs };
}

function nuxtPropsFromAttrs(attrs: Array<[string, string]>, isTs: boolean): string {
  const parts: string[] = [];
  for (const [key, value] of attrs) {
    const lkey = key.toLowerCase();
    const propKey =
      REACT_ATTR_ALIASES[lkey] ??
      SVG_ATTR_ALIASES[lkey] ??
      SVG_ATTR_ALIASES[lkey.replace(/-/g, "")] ??
      key;
    if (key === "class") {
      parts.push(`className={${JSON.stringify(value)}}`);
    } else if (lkey === "tabindex" && /^-?\d+$/.test(value)) {
      parts.push(`tabIndex={${value}}`);
    } else if (lkey === "inert") {
      // React 18 treats inert as a boolean attribute (typed) yet warns on the
      // boolean form at runtime; a string value writes inert="" with no warning
      // and the archived runtime re-applies its own state anyway.
      parts.push(isTs ? `{...({ "inert": "" } as any)}` : `inert={""}`);
    } else if (value === "") {
      parts.push(propKey);
    } else if (
      /^(data-|aria-)/.test(key) ||
      [
        "id",
        "role",
        "href",
        "src",
        "type",
        "integrity",
        "alt",
        "title",
        "lang",
        "value",
        "name",
        "for",
        "placeholder",
        "crossorigin",
        "target",
        "rel",
        "download",
        "loading",
      ].includes(lkey)
    ) {
      parts.push(`${propKey}={${JSON.stringify(value)}}`);
    } else {
      const spread = `{...({ ${JSON.stringify(propKey)}: ${JSON.stringify(value)} }${isTs ? " as any" : ""})}`;
      parts.push(spread);
    }
  }
  return parts.join(" ");
}

function nuxtEditableBlock(
  el: ParsedHTMLElement,
  key: string,
  name: string,
  cssVars: Array<{ selector: string; decl: string }>,
  isTs: boolean,
): NuxtEditableBlock {
  const selector = nuxtBlockSelector(el);
  const { styleProp, attrs } = extractRootCssVars(el, selector, cssVars);
  const anchors: NuxtInteriorAnchor[] = [];
  collectInteriorAnchors(el, [], anchors);
  anchors.reverse();
  const texts: NuxtTextRegion[] = [];
  collectTextRegions(el, [], texts);
  return {
    key,
    name,
    tag: el.tagName.toLowerCase(),
    props: nuxtPropsFromAttrs(attrs, isTs),
    styleProp,
    inner: el.innerHTML ?? "",
    readable: nuxtInteriorChildren(el, isTs, 1, false),
    anchors,
    texts,
    selector,
  };
}

// Selector-keyed text regions for the editable hook and the static overlay:
// the archive's own scripts re-write page text on hydration, so the user's
// edits (authored text) must be re-applied after the runtime settles.
function nuxtTextRegions(editable: NuxtEditable): { selector: string; texts: NuxtTextRegion[] }[] {
  const entries: { selector: string; texts: NuxtTextRegion[] }[] = [];
  const push = (block: NuxtEditableBlock) => {
    if (block.texts.length) entries.push({ selector: block.selector, texts: block.texts });
  };
  for (const block of [
    ...editable.sections,
    ...editable.blocksBefore,
    ...editable.blocksAfter,
    ...editable.support,
  ])
    push(block);
  return entries;
}

// Whole-tree text regions for the live Vite/Next runtime hook. Unlike
// nuxtTextRegions() this does not depend on the editable-composition layout
// (buildNuxtEditable requires <main> to be a direct child of #__nuxt), so
// layouts such as `#__nuxt > .container > main` are covered as well: every
// non-empty text node under #__nuxt is tracked relative to that root.
function collectNuxtTextRegions(html: string): { selector: string; texts: NuxtTextRegion[] }[] {
  const root = parseHtml(html, PARSE_OPTIONS);
  const nuxt = root.querySelector("#__nuxt");
  if (nuxt) {
    const texts: NuxtTextRegion[] = [];
    collectTextRegions(nuxt, [], texts);
    if (texts.length) return [{ selector: "#__nuxt", texts }];
  }
  const body = root.querySelector("body");
  if (body) {
    const texts: NuxtTextRegion[] = [];
    collectTextRegions(body, [], texts);
    if (texts.length) return [{ selector: "body", texts }];
  }
  return [];
}

// Runtime hook for full-page frameworks (Nuxt) that rebuild #__nuxt from the
// inlined payload after React renders: the archived runtime overwrites the
// React-rendered text, so texts the user edited in the section files are
// captured before boot and re-applied afterwards (MutationObserver + a slow
// interval, mirroring the static overlay). The caller keeps loading the
// scripts; capture runs first so it sees the authored JSX output.
function nuxtTextHookSource(
  utilsImport: string,
  loaders: string[],
  regions: { selector: string; texts: NuxtTextRegion[] }[],
  anchors: NuxtInteriorAnchor[] = [],
): string {
  const restoreNuxtAnchorsFn = anchors && anchors.length
    ? `function restoreNuxtAnchors(anchors){
        try{
          const root=document.querySelector("#__nuxt")||document.body;
          for(let i=0;i<anchors.length;i++){
            const a=anchors[i];
            if(!a) continue;
            let node=root;
            let ok=true;
            for(const step of a.path||[]){
              const child=node.children[step];
              if(!child){ ok=false; break; }
              node=child;
            }
            if(!ok) continue;
            const fence=node.children[a.index] ?? null;
            node.insertBefore(document.createComment(a.token), fence);
          }
        }catch(e){}
      }`
    : "";
  const anchorCall = anchors && anchors.length
    ? `  try { if (typeof restoreNuxtAnchors === "function") restoreNuxtAnchors(anchors); } catch (e) {}\n`
    : "";
  return String.raw`import { useEffect } from "react";${restoreNuxtAnchorsFn ? restoreNuxtAnchorsFn + "\n" : ""}${anchorCall || ""}
import { loadScript } from ${JSON.stringify(utilsImport)};

// Text nodes under #__nuxt. At render time React writes the text you authored
// in the section files; the archived runtime then rebuilds #__nuxt from its
// inline payload and rewrites them, so any text that differs from the
// server-rendered baseline (i.e. your edit) is re-applied after boot.
const NUXT_TEXTS = ${JSON.stringify(regions)};

function locateText(root, path, index) {
  let node = root;
  for (const step of path) {
    const child = node.children[step];
    if (!child) return null;
    node = child;
  }
  let elementsSeen = 0;
  for (const child of node.childNodes) {
    if (child.nodeType === 1) {
      if (elementsSeen === index) return null;
      elementsSeen += 1;
    } else if (child.nodeType === 3 && child.textContent && child.textContent.trim()) {
      if (elementsSeen === index) return child;
    }
  }
  return null;
}

function normText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

export function useSiteScripts() {
  useEffect(() => {
    const tracked = [];
    for (const entry of NUXT_TEXTS) {
      const root = document.querySelector(entry.selector);
      if (!root) continue;
      for (const region of entry.texts) {
        const node = locateText(root, region.path, region.index);
        if (!node || !node.textContent || !node.textContent.trim()) continue;
        if (normText(node.textContent) === normText(region.text)) continue;
        tracked.push({ selector: entry.selector, path: region.path, index: region.index, authored: node.textContent });
      }
    }

    const resolve = (t) => {
      const root = document.querySelector(t.selector);
      if (!root || !root.isConnected) return null;
      const node = locateText(root, t.path, t.index);
      return node && node.isConnected ? node : null;
    };
    const apply = () => {
      for (const t of tracked) {
        try {
          const node = t.node && t.node.isConnected ? t.node : resolve(t);
          if (!node) continue;
          t.node = node;
          if (node.textContent !== t.authored) node.textContent = t.authored;
        } catch (_error) {}
      }
    };
    const observer =
      tracked.length && "MutationObserver" in window ? new MutationObserver(apply) : null;
    if (observer)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

${loaders.join("\n")}

    if (tracked.length) {
      window.addEventListener("load", apply);
      window.setTimeout(apply, 300);
      window.setInterval(apply, 1200);
    }
  }, []);
}
`;
}

function nuxtSectionName(el: ParsedHTMLElement, used: Set<string>): string {
  const cls = el.getAttribute("class") ?? "";
  let token = cls
    .split(/\s+/)
    .filter(
      (c) =>
        c.length > 2 &&
        /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(c) &&
        !c.startsWith("u-") &&
        !c.startsWith("is-"),
    )[0];
  if (token?.startsWith("s-") && token.length > 2) token = token.slice(2);
  const pascal =
    (token ?? "section")
      .split("-")
      .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
      .join("") + "Section";
  let name = pascal === "USPSSection" ? pascal : pascal;
  if (name === "UspsSection") name = "USPSSection";
  if (name === "FaqSection") name = "FAQSection";
  let candidate = name;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${name}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function nuxtBlockName(el: ParsedHTMLElement, index: number, used: Set<string>): string {
  const tag = el.tagName.toLowerCase();
  let name = `Block${index}`;
  if (tag === "a") name = "SkipLink";
  else if (tag === "header") name = "SiteHeader";
  else if (tag === "footer") name = "SiteFooter";
  while (used.has(name)) {
    name += index;
    index += 1;
  }
  used.add(name);
  return name;
}

function buildNuxtEditable(html: string, isTs: boolean): NuxtEditable | null {
  const root = parseHtml(html, PARSE_OPTIONS);
  const body = root.querySelector("body");
  const nuxt = root.querySelector("#__nuxt");
  if (!body || !nuxt) return null;
  const nuxtChildren = (nuxt.childNodes ?? []).filter(
    (child: { rawText?: string }) =>
      (child as { nodeType?: number }).nodeType === 1 ||
      (child as { nodeType?: number }).nodeType === 8,
  );
  const elements = nuxtChildren.filter(
    (child: { nodeType?: number }) => (child as { nodeType?: number }).nodeType === 1,
  ) as ParsedHTMLElement[];
  const mainIndex = elements.findIndex((el) => el.tagName === "MAIN");
  if (mainIndex < 0) return null;
  const main = elements[mainIndex]!;
  const cssVars: Array<{ selector: string; decl: string }> = [];
  const used = new Set<string>();
  const blocksBefore: NuxtEditableBlock[] = [];
  const blocksAfter: NuxtEditableBlock[] = [];
  for (let i = 0; i < elements.length; i += 1) {
    if (i === mainIndex) continue;
    const el = elements[i]!;
    const block = nuxtEditableBlock(el, `block${i}`, nuxtBlockName(el, i, used), cssVars, isTs);
    if (i < mainIndex) blocksBefore.push(block);
    else blocksAfter.push(block);
  }
  const mainEls = (main.childNodes ?? []).filter(
    (child: { nodeType?: number }) => (child as { nodeType?: number }).nodeType === 1,
  ) as ParsedHTMLElement[];
  let wrap: ParsedHTMLElement | null = null;
  let sectionEls = mainEls;
  if (mainEls.length === 1 && mainEls[0]!.tagName === "DIV") {
    wrap = mainEls[0]!;
    sectionEls = (wrap.childNodes ?? []).filter(
      (child: { nodeType?: number }) => (child as { nodeType?: number }).nodeType === 1,
    ) as ParsedHTMLElement[];
  }
  if (!sectionEls.length) return null;
  const sections = sectionEls.map((el, i) =>
    nuxtEditableBlock(el, `section${i}`, nuxtSectionName(el, used), cssVars, isTs),
  );
  const anchors: NuxtEditableAnchor[] = [];
  let lastEl: ParsedHTMLElement | null = null;
  for (const child of nuxtChildren) {
    const node = child as { nodeType?: number; rawText?: string };
    if (node.nodeType === 1) {
      lastEl = child as ParsedHTMLElement;
    } else if (node.nodeType === 8) {
      const token = node.rawText ?? "";
      if (lastEl) anchors.push(["after", nuxtBlockSelector(lastEl), token]);
      else anchors.push(["prepend", "", token]);
    }
  }
  const supportEls = (body.childNodes ?? [])
    .filter((child: { nodeType?: number }) => (child as { nodeType?: number }).nodeType === 1)
    .filter(
      (el) => (el as ParsedHTMLElement).getAttribute("id") !== "__nuxt",
    ) as ParsedHTMLElement[];
  const support = supportEls.map((el, i) =>
    nuxtEditableBlock(el, `support${i}`, `Support${i}`, cssVars, isTs),
  );
  return {
    support,
    anchors,
    blocksBefore,
    blocksAfter,
    main: nuxtEditableBlock(main, "main", "Main", cssVars, isTs),
    wrap: wrap ? nuxtEditableBlock(wrap, "wrap", "FrontPage", cssVars, isTs) : null,
    sections,
    cssVars,
  };
}

function editableSupportJsx(block: NuxtEditableBlock, indent: string): string {
  const attrs = `${block.props}${block.styleProp ? ` ${block.styleProp}` : ""}`.trim();
  if (block.tag === "script") {
    if (block.inner) {
      return `${indent}<script ${attrs} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(block.inner)} }} />`;
    }
    return `${indent}<script ${attrs}></script>`;
  }
  if (!block.inner) {
    return `${indent}<${block.tag} ${attrs}></${block.tag}>`;
  }
  return `${indent}<${block.tag} ${attrs} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(block.inner)} }} />`;
}

function editableComponentCode(block: NuxtEditableBlock, isTs: boolean): string {
  const props = `${block.props}${block.styleProp ? ` ${block.styleProp}` : ""}`.trim();
  const body = block.readable.length
    ? `  <${block.tag} ${props}>\n${block.readable.join("\n")}\n  </${block.tag}>`
    : `  <${block.tag} ${props} />`;
  return `// ${block.name} - editable root. Authored as real JSX so it reads and edits
// like hand-written code; the original markup, attributes and Vue fragment
// comments are preserved automatically for the archived runtime.
export default function ${block.name}() {
  return (
${body}
  );
}
`;
}

function editableMainJsx(editable: NuxtEditable, indent: string): string {
  const lines: string[] = [];
  const mainProps =
    `${editable.main.props}${editable.main.styleProp ? ` ${editable.main.styleProp}` : ""}`.trim();
  lines.push(`${indent}<main ${mainProps}>`);
  const innerIndent = `${indent}  `;
  if (editable.wrap) {
    const wrapProps =
      `${editable.wrap.props}${editable.wrap.styleProp ? ` ${editable.wrap.styleProp}` : ""}`.trim();
    lines.push(`${innerIndent}<div ${wrapProps}>`);
    for (const section of editable.sections) {
      lines.push(`${innerIndent}  <${section.name} />`);
    }
    lines.push(`${innerIndent}</div>`);
  } else {
    for (const section of editable.sections) {
      lines.push(`${innerIndent}<${section.name} />`);
    }
  }
  lines.push(`${indent}</main>`);
  return lines.join("\n");
}

function editableHookLoader(editable: NuxtEditable): string {
  const interior = [...editable.sections, ...editable.blocksBefore, ...editable.blocksAfter]
    .filter((block) => block.anchors.length)
    .map((block) => ({ selector: block.selector, anchors: block.anchors }));
  const texts = nuxtTextRegions(editable);
  return `import { useEffect } from "react";

// Vue fragment anchors lifted from the original SSR markup. React cannot render
// comment nodes, so they are inserted before the legacy bundle boots; the
// hydrating runtime then sees the exact comment layout it wrote server-side.
const NUXT_ANCHORS = ${JSON.stringify(editable.anchors)};
const NUXT_INTERIOR = ${JSON.stringify(interior)};

// Text nodes owned by the archived runtime. At render time React writes the
// text you authored in the section files; the runtime then re-writes some of it
// on hydration, so text you actually changed is re-applied after boot.
const NUXT_TEXTS = ${JSON.stringify(texts)};

function restoreNuxtAnchors() {
  const nuxt = document.getElementById("__nuxt");
  if (!nuxt) return;
  for (const [kind, selector, token] of NUXT_ANCHORS) {
    const comment = document.createComment(token);
    if (kind === "after") {
      (nuxt.querySelector(selector) ?? nuxt).after(comment);
    } else {
      nuxt.prepend(comment);
    }
  }
}

// Section/block interiors were authored as editable JSX; any comment nodes the
// original SSR markup carried between elements are re-inserted at their exact
// positions (path = element-child indexes down from the root, index = element-
// child position inside the target parent).
function restoreInteriorAnchors() {
  const nuxt = document.getElementById("__nuxt");
  if (!nuxt) return;
  for (const entry of NUXT_INTERIOR) {
    const root = nuxt.querySelector(entry.selector);
    if (!root) continue;
    for (const anchor of entry.anchors) {
      let node = root;
      for (const step of anchor.path) {
        const child = node.children[step];
        if (!child) {
          node = null;
          break;
        }
        node = child;
      }
      if (!node) continue;
      const fence = node.children[anchor.index] ?? null;
      node.insertBefore(document.createComment(anchor.token), fence);
    }
  }
}

// Resolves the text node under \`root\` at element-chain \`path\`, sitting right
// before the \`index\`-th element child of the target parent (comments and
// whitespace-only text nodes are skipped, matching how they were collected).
function locateText(root, path, index) {
  let node = root;
  for (const step of path) {
    const child = node.children[step];
    if (!child) return null;
    node = child;
  }
  let elementsSeen = 0;
  const nodes = node.childNodes;
  for (const child of nodes) {
    if (child.nodeType === 1) {
      if (elementsSeen === index) return null;
      elementsSeen += 1;
    } else if (child.nodeType === 3 && child.textContent && child.textContent.trim()) {
      if (elementsSeen === index) return child;
    }
  }
  return null;
}

// Whitespace-insensitive compare: only REAL content edits on the text the user
// authored in the section files are tracked (JSX emission adds no whitespace,
// but being defensive here keeps the apply set tiny and collision-free).
function normText(s) {
  return (s || "").replace(/\\s+/g, " ").trim();
}

export function useSiteScripts() {
  useEffect(() => {
    restoreNuxtAnchors();
    restoreInteriorAnchors();

    // In the Vite/Next clones the React app renders the section files first and
    // the archived runtime then takes the DOM over, so the authored text has to
    // be captured from whichever host already carries it at mount time.
    // Prefer the React tree (#root), then the archived #__nuxt, then the body.
    const tracked = [];
    const hosts = [];
    const rootEl = document.getElementById("root");
    const nuxtEl = document.getElementById("__nuxt");
    if (rootEl) hosts.push(rootEl);
    if (nuxtEl) hosts.push(nuxtEl);
    hosts.push(document.body);
    for (const entry of NUXT_TEXTS) {
      let captured = false;
      for (const host of hosts) {
        const root = host.querySelector(entry.selector);
        if (!root || !root.isConnected) continue;
        for (const region of entry.texts) {
          const node = locateText(root, region.path, region.index);
          if (!node || !node.textContent || !node.textContent.trim()) continue;
          if (normText(node.textContent) === normText(region.text)) continue;
          tracked.push({ node, region, root, selector: entry.selector, authored: node.textContent });
          captured = true;
        }
        if (captured) break;
      }
    }
    const nuxt = nuxtEl;

    // The archived runtime keeps re-rendering after boot, reverting the edited
    // text; every DOM mutation (de-bounced) re-applies the authored copy. Nodes
    // the runtime re-created are re-located by path before re-applying.
    // Re-resolves an entry against the live DOM: the runtime may replace whole
    // sections, so the root is re-queried by selector on every pass.
    const resolve = (t) => {
      for (const source of [nuxt, document.body]) {
        if (!source) continue;
        const root = source.querySelector(t.selector);
        if (root && root.isConnected) {
          const node = locateText(root, t.region.path, t.region.index);
          if (node && node.isConnected) return { root, node };
        }
      }
      return null;
    };
    const apply = () => {
      for (const t of tracked) {
        try {
          const hit = t.node && t.node.isConnected ? t : resolve(t);
          if (!hit) continue;
          t.root = hit.root;
          t.node = hit.node;
          if (t.node.textContent !== t.authored) {
            t.node.textContent = t.authored;
          }
        } catch (_e) {}
      }
    };
    const observer =
      "MutationObserver" in window
        ? new MutationObserver(apply)
        : null;
    if (observer) observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    const boot = () => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = "/js/main.mjs";
      script.async = true;
      script.onerror = () => script.remove();
      script.onload = apply;
      document.body.appendChild(script);
    };
    const script = document.createElement("script");
    script.src = "/js/main.js";
    script.async = true;
    script.onload = boot;
    script.onerror = boot;
    document.body.appendChild(script);
    window.addEventListener("load", apply);
    window.setTimeout(apply, 300);
    window.setInterval(apply, 1200);
  }, []);
}
`;
}

function viteShellFiles(
  html: string,
  source: URL,
  language: ExportLanguage = "jsx",
  editable: NuxtEditable | null = null,
): Record<string, Uint8Array> {
  const ext = languageExtension(language);
  const codeExt = codeExtension(language);
  const isTs = language === "tsx";
  const devDependencies: Record<string, string> = {
    "@vitejs/plugin-react": "^4.3.4",
    // vite 5 ships a rollup 4 native addon that Windows Smart App Control blocks
    // by default; vite 4 uses pure-JS rollup 3 so exports run on any Windows box.
    vite: "^4.5.5",
  };
  if (isTs) {
    devDependencies["@types/react"] = "^18.3.12";
    devDependencies["@types/react-dom"] = "^18.3.1";
    devDependencies["typescript"] = "^5.6.3";
  }
  const files: Record<string, Uint8Array> = {
    "package.json": strToU8(
      JSON.stringify(
        {
          name: "site-clone-vite",
          private: true,
          type: "module",
          scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
          dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies,
        },
        null,
        2,
      ),
    ),
    "vite.config.js": strToU8(
      'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n',
    ),
    "index.html": strToU8(
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>Clone of ${source.hostname}</title>\n  </head>\n  <body>\n    ${SAFETY_SCRIPT}\n    <div id="root"></div>\n    <script type="module" src="/src/main.${ext}"></script>\n  </body>\n</html>\n`,
    ),
    [`src/main.${ext}`]: strToU8(
      `import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")).render(<App />);
`,
    ),
    "src/index.css": strToU8(""),
  };
  if (editable) {
    const supportJsx = editable.support
      .map((block) => editableSupportJsx(block, "      "))
      .join("\n");
    const importSections = editable.sections
      .map((s) => `import ${s.name} from "./components/section/${s.name}";`)
      .join("\n");
    const importBlocks = [...editable.blocksBefore, ...editable.blocksAfter]
      .map((b) => `import ${b.name} from "./components/section/${b.name}";`)
      .join("\n");
    const beforeJsx = editable.blocksBefore.map((b) => `        <${b.name} />`).join("\n");
    const afterJsx = editable.blocksAfter.map((b) => `        <${b.name} />`).join("\n");
    files[`src/App.${ext}`] = strToU8(
      `import { useSiteScripts } from "./hooks/useSiteScripts";
${importSections}
${importBlocks}

export default function App() {
  useSiteScripts();

  return (
    <>
      {/* SSR runtime payload (id-linked, the archived app reads these by id) */}
${supportJsx}
      <div id="__nuxt">
${beforeJsx}
${editableMainJsx(editable, "        ")}
${afterJsx}
      </div>
    </>
  );
}
`,
    );
    for (const block of [...editable.blocksBefore, ...editable.blocksAfter, ...editable.sections]) {
      files[`src/components/section/${block.name}.${ext}`] = strToU8(
        editableComponentCode(block, isTs),
      );
    }
    files[`src/hooks/useSiteScripts.${codeExt}`] = strToU8(editableHookLoader(editable));
    return files;
  }
  files[`src/App.${ext}`] = strToU8(
    `import { useSiteScripts } from "./hooks/useSiteScripts";

const SHELL_HTML = ${JSON.stringify(fullFidelityShellHtml(html))};

export default function App() {
  useSiteScripts();

  return <div className="site-shell" dangerouslySetInnerHTML={{ __html: SHELL_HTML }} />;
}
`,
  );
  files[`src/hooks/useSiteScripts.${codeExt}`] = strToU8(SITE_SHELL_SCRIPT_LOADER);
  return files;
}

function nextShellFiles(
  html: string,
  source: URL,
  language: ExportLanguage = "tsx",
  editable: NuxtEditable | null = null,
): Record<string, Uint8Array> {
  const ext = languageExtension(language);
  const codeExt = codeExtension(language);
  const isTs = language === "tsx";
  const files: Record<string, Uint8Array> = {
    "package.json": strToU8(
      JSON.stringify(
        {
          name: "site-clone-next",
          private: true,
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: { next: "^14.2.15", react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: {
            "@types/node": "^22.8.1",
            "@types/react": "^18.3.12",
            typescript: "^5.6.3",
          },
        },
        null,
        2,
      ),
    ),
    "next.config.mjs": strToU8(
      "/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: false };\n\nexport default nextConfig;\n",
    ),
    "tsconfig.json": strToU8(
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2020",
            lib: ["ES2020", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "preserve",
            allowJs: true,
            strict: false,
            esModuleInterop: true,
            resolveJsonModule: true,
            isolatedModules: true,
            skipLibCheck: true,
            noEmit: true,
            incremental: true,
            baseUrl: ".",
            paths: { "@/*": ["./*"] },
            plugins: [{ name: "next" }],
          },
          include: [
            "next-env.d.ts",
            "**/*.ts",
            "**/*.tsx",
            "**/*.js",
            "**/*.jsx",
            ".next/types/**/*.ts",
          ],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
    ),
    "next-env.d.ts": strToU8(
      '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    ),
    [`app/layout.${ext}`]: strToU8(
      `import "./globals.css";
import { site } from "@/data/site";

export const metadata = {
  title: site.title,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script data-site-cloner-safety dangerouslySetInnerHTML={{ __html: ${JSON.stringify(SAFETY_SCRIPT_RAW)} }} />
        {children}
      </body>
    </html>
  );
}
`,
    ),
    "app/globals.css": strToU8(""),
  };
  files[`data/site.${codeExt}`] = strToU8(
    `export const site = {
  title: ${JSON.stringify(`Clone of ${source.hostname}`)},
  source: ${JSON.stringify(source.origin)},
};
`,
  );
  if (editable) {
    const supportJsx = editable.support
      .map((block) => editableSupportJsx(block, "      "))
      .join("\n");
    const importSections = editable.sections
      .map((s) => `import ${s.name} from "@/components/section/${s.name}";`)
      .join("\n");
    const importBlocks = [...editable.blocksBefore, ...editable.blocksAfter]
      .map((b) => `import ${b.name} from "@/components/section/${b.name}";`)
      .join("\n");
    const beforeJsx = editable.blocksBefore.map((b) => `        <${b.name} />`).join("\n");
    const afterJsx = editable.blocksAfter.map((b) => `        <${b.name} />`).join("\n");
    files[`app/page.${ext}`] = strToU8(
      `"use client";

import { useSiteScripts } from "@/hooks/useSiteScripts";
${importSections}
${importBlocks}

export default function Page() {
  useSiteScripts();

  return (
    <>
      {/* SSR runtime payload (id-linked, the archived app reads these by id) */}
${supportJsx}
      <div id="__nuxt">
${beforeJsx}
${editableMainJsx(editable, "        ")}
${afterJsx}
      </div>
    </>
  );
}
`,
    );
    for (const block of [...editable.blocksBefore, ...editable.blocksAfter, ...editable.sections]) {
      files[`components/section/${block.name}.${ext}`] = strToU8(
        editableComponentCode(block, isTs),
      );
    }
    files[`hooks/useSiteScripts.${codeExt}`] = strToU8(editableHookLoader(editable));
    return files;
  }
  files[`app/page.${ext}`] = strToU8(
    `"use client";

import { useSiteScripts } from "@/hooks/useSiteScripts";

const SHELL_HTML = ${JSON.stringify(fullFidelityShellHtml(html))};

export default function Page() {
  useSiteScripts();

  return (
    <div className="site-shell" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: SHELL_HTML }} />
  );
}
`,
  );
  files[`hooks/useSiteScripts.${codeExt}`] = strToU8(SITE_SHELL_SCRIPT_LOADER);
  return files;
}

function nextFiles(
  html: string,
  source: URL,
  sections: { name: string; filePath: string; code: string }[],
  layout: string,
  components: { name: string; filePath: string; code: string }[] = [],
  language: ExportLanguage = "tsx",
) {
  const ext = languageExtension(language);
  const codeExt = codeExtension(language);
  const isTs = language === "tsx";
  const loaders = buildLoadCalls(html, "    ");
  const payload = nuxtPayload(html);
  const payloadJsx = payload
    ? `<script${payload.attrs.map(([name, value]) => ` ${name}="${value}"`).join("")} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(payload.json)} }} />`
    : "";
  // Boot the archived runtime only when it has the state it hydrates from;
  // without the payload a full-page framework wipes the mirrored sections.
  const bootRuntime = !isFullPageRuntimeApp(html) || payload != null;
  // Full-page frameworks overwrite the React-rendered text on hydration; track
  // the whole #__nuxt tree so edits in the section files can be re-applied.
  const textRegions = bootRuntime ? collectNuxtTextRegions(html) : [];
  const anchors = bootRuntime ? collectInteriorAnchorsFromHtml(html) : [];
  const nextSectionList = sections
    .slice(0, 4)
    .map((s) => `${s.name}.${ext}`)
    .join(", ")
    .concat(sections.length > 4 ? ", ..." : "");
  const pageImports = referencedModules(sections, components, layout)
    .map((ref) =>
      ref.kind === "section"
        ? `import { ${ref.name} } from "@/components/section/${ref.name}";`
        : `import { ${ref.name} } from "@/components/ui/${ref.name}";`,
    )
    .join("\n");
  const hookSource =
    bootRuntime
      ? nuxtTextHookSource("@/utils/loadScript", loaders, textRegions, anchors)
      : `import { useEffect } from "react";

// The runtime would need a per-deploy payload it cannot boot without, so the
// mirrored markup is the finished page and the bundle is never attached.
export function useSiteScripts() {
  useEffect(() => {}, []);
}
`;
  const files: Record<string, Uint8Array> = {
    "package.json": strToU8(
      JSON.stringify(
        {
          name: "site-clone-next",
          private: true,
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: { next: "^14.2.15", react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: {
            "@types/node": "^22.8.1",
            "@types/react": "^18.3.12",
            typescript: "^5.6.3",
          },
        },
        null,
        2,
      ),
    ),
    "next.config.mjs": strToU8(
      "/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: false };\n\nexport default nextConfig;\n",
    ),
    "tsconfig.json": strToU8(
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2020",
            lib: ["ES2020", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "preserve",
            allowJs: true,
            strict: false,
            esModuleInterop: true,
            resolveJsonModule: true,
            isolatedModules: true,
            skipLibCheck: true,
            noEmit: true,
            incremental: true,
            baseUrl: ".",
            paths: { "@/*": ["./*"] },
            plugins: [{ name: "next" }],
          },
          include: [
            "next-env.d.ts",
            "**/*.ts",
            "**/*.tsx",
            "**/*.js",
            "**/*.jsx",
            ".next/types/**/*.ts",
          ],
          exclude: ["node_modules"],
        },
        null,
        2,
      ),
    ),
    "next-env.d.ts": strToU8(
      '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    ),
    [`app/layout.${ext}`]: strToU8(
      isTs
        ? `import type { Metadata } from "next";
import "./globals.css";
import { site } from "@/data/site";

export const metadata: Metadata = {
  title: site.title,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script data-site-cloner-safety dangerouslySetInnerHTML={{ __html: ${JSON.stringify(SAFETY_SCRIPT_RAW)} }} />
        ${payloadJsx}
        {children}
      </body>
    </html>
  );
}
`
        : `import "./globals.css";
import { site } from "@/data/site";

export const metadata = {
  title: site.title,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script data-site-cloner-safety dangerouslySetInnerHTML={{ __html: ${JSON.stringify(SAFETY_SCRIPT_RAW)} }} />
        ${payloadJsx}
        {children}
      </body>
    </html>
  );
}
`,
    ),
    [`app/page.${ext}`]: strToU8(
      `"use client";

${pageImports}
import { useSiteScripts } from "@/hooks/useSiteScripts";

export default function Page() {
  useSiteScripts();

  return (
    <>
${indentText(layout, 3)}
    </>
  );
}
`,
    ),
    // Catch-all so deep links to archived client-side routes (e.g.
    // /programs/3-to-18) render the shell instead of 404; the archived router
    // re-applies the real route once the runtime boots.
    [`app/[...slug]/page.${ext}`]: strToU8(
      `"use client";

${pageImports}
import { useSiteScripts } from "@/hooks/useSiteScripts";

export default function CatchAllPage() {
  useSiteScripts();

  return (
    <>
${indentText(layout, 3)}
    </>
  );
}
`,
    ),
    [`hooks/useSiteScripts.${codeExt}`]: strToU8(hookSource),
    [`utils/loadScript.${codeExt}`]: strToU8(
      isTs
        ? `export function loadScript(src: string, { module = false }: { module?: boolean } = {}) {
  const script = document.createElement("script");
  if (module) script.type = "module";
  script.src = src;
  script.async = true;
  script.onerror = () => script.remove();
  document.body.appendChild(script);
}
`
        : `export function loadScript(src, { module = false } = {}) {
  const script = document.createElement("script");
  if (module) script.type = "module";
  script.src = src;
  script.async = true;
  script.onerror = () => script.remove();
  document.body.appendChild(script);
}
`,
    ),
    [`data/site.${codeExt}`]: strToU8(
      `export const site = {
  title: ${JSON.stringify(`Clone of ${source.hostname}`)},
  source: ${JSON.stringify(source.origin)},
};
`,
    ),
    "app/api/.gitkeep": strToU8(""),
    "README.md": strToU8(
      `# ${source.hostname} - Next.js clone\n\nA Next.js (App Router) project mirroring ${source.origin}. Each page section is\nits own component, composed in \`app/page.${ext}\`. The original site's runtime is\nshipped under \`public/js/\` and attached after mount, so the animations, scroll\neffects and responsive behaviour match the live site.\n\n## Quick start\n\n\`\`\`bash\nnpm install\nnpm run dev      # http://localhost:3000\nnpm run build    # production build\n\`\`\`\n\n## Project structure\n\n\`\`\`\napp/\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ layout.${ext}                   Root layout, metadata & safety script\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ page.${ext}                     Composes the sections into the page\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ globals.css                     All styles from the original site\nÃ¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬ api/                            Route handlers\ncomponents/section/                 One component per page section - edit here\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ ${nextSectionList}\ncomponents/ui/                      Reusable UI components (buttons, icons, badges)\nhooks/useSiteScripts.${codeExt}           Loads the original runtime after mount\nutils/loadScript.${codeExt}               Small DOM <script> loader\ndata/                               Site metadata\npublic/\nÃ¢â€Å“Ã¢â€â‚¬Ã¢â€â‚¬ js/                             Original runtime scripts (main.js, main.mjs)\nÃ¢â€â€Ã¢â€â‚¬Ã¢â€â‚¬ images | videos | audio | fonts | icons/   Media assets\n\`\`\`\n\n## Editing content\n\nEdit the section components in \`components/section/\`:\n\`\`\`${isTs ? "tsx" : "jsx"}\nexport function HeroSection() {\n  return (\n    <section className="hero">\n      <h1>Edit this text</h1>\n      <img src="/images/hero.jpg" alt="Hero" />\n    </section>\n  );\n}\n\`\`\`\n\n- **Text** is plain JSX - change it directly. Text the original runtime rewrites\n  at load (counters, dates) is written by \`public/js/\`, not the JSX.\n- **Styles** live in \`app/globals.css\` - change colours, spacing, fonts and media\n  paths there.\n- Deploy as-is to Vercel or any Next.js host.\n`,
    ),
  };

  if (isTs) {
    files["global.d.ts"] = strToU8(GLOBAL_DTS);
  }

  for (const section of sections) {
    files[section.filePath] = strToU8(section.code);
  }

  for (const component of components) {
    files[component.filePath] = strToU8(component.code);
  }

  return files;
}

// Turns every relative reference absolute so the downloader can find it and the
// archive can then point at bundled local copies instead of the origin.
function absolutizeHtml(html: string, base: URL) {
  const root = parseHtml(html, PARSE_OPTIONS);
  for (const node of root.querySelectorAll("base")) node.remove();
  const resolve = (value: string) => {
    try {
      if (!value || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value.trim())) return value;
      return new URL(value.trim(), base).toString();
    } catch {
      return value;
    }
  };
  for (const node of root.querySelectorAll(
    "[src],[href],[poster],[data-src],[data-img],[data-cursor-img],[data-image],[data-thumb],[data-poster],[data-background-image],[content]",
  )) {
    for (const attribute of [
      "src",
      "href",
      "poster",
      "data-src",
      "data-img",
      "data-cursor-img",
      "data-image",
      "data-thumb",
      "data-poster",
      "data-background-image",
    ]) {
      const value = node.getAttribute(attribute);
      if (value) node.setAttribute(attribute, resolve(value));
    }
    const property = node.getAttribute("property") || node.getAttribute("name") || "";
    const content = node.getAttribute("content");
    if (content && /image|url|video|audio/i.test(property))
      node.setAttribute("content", resolve(content));
  }
  for (const node of root.querySelectorAll("[srcset]")) {
    const srcset = node.getAttribute("srcset");
    if (!srcset) continue;
    node.setAttribute(
      "srcset",
      srcset
        .split(",")
        .map((entry) => {
          const [candidate, ...rest] = entry.trim().split(/\s+/);
          return [resolve(candidate ?? ""), ...rest].join(" ");
        })
        .join(", "),
    );
  }
  return root.toString();
}

/**
 * Read a source entry module's `export { x as Y }` list and emit ESM lines that
 * re-export each name from the merged weaver bundle, e.g.
 * `export const $ = __weaverRoot("js/<hash>-entry.js").$;`
 *
 * The bundle folds the entry module into main.mjs, but raw sibling chunks
 * (Nuxt/Vite route chunks) import its surface with a plain relative import;
 * rewriteChunkEntryImport points those at main.mjs, and this suffix supplies
 * the names they expect.
 */
function buildEntryExportsSuffix(entryAsset: DownloadedAsset | null, entrySpec: string): string {
  if (!entryAsset || !entrySpec) return "";
  let body = "";
  try {
    body = new TextDecoder().decode(entryAsset.bytes);
  } catch {
    return "";
  }
  const seen = new Set<string>();
  for (const match of body.matchAll(/export\s*\{([\s\S]*?)\}\s*;?/g)) {
    const list = match[1];
    if (!list) continue;
    for (const part of list.split(",")) {
      const spec = part.trim();
      if (!spec) continue;
      const at = spec.indexOf(" as ");
      const exported = (at >= 0 ? spec.slice(at + 4) : spec).trim();
      if (exported === "default" || /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exported)) seen.add(exported);
    }
  }
  if (!seen.size) return "";
  const host = JSON.stringify(entrySpec.replace(/^\/+/, ""));
  const lines: string[] = [];
  for (const name of seen) {
    if (name === "default") {
      lines.push(`const __weaverDefaultExport = __weaverRoot(${host}).default;`);
      lines.push(`export { __weaverDefaultExport as default };`);
    } else {
      lines.push(`export const ${name} = __weaverRoot(${host}).${name};`);
    }
  }
  return `\n${lines.join("\n")}\n`;
}

const INTRO_CURTAIN_CSS = `
/* Intro curtain animation replay for maximatherapy clone */
.intro-curtain {
  animation: mxt-curtain-slide 4s ease-out forwards;
  pointer-events: auto;
}
.intro-curtain .scale-0 {
  animation: mxt-bubble-pop 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) 0.4s both;
}
.intro-curtain .curtain-title {
  animation: mxt-title-reveal 1.4s cubic-bezier(0.16, 1, 0.3, 1) 0.6s both;
  font-size: clamp(3rem, 8vw, 8rem);
  font-weight: 700;
  line-height: 1.1;
}
.intro-curtain .curtain-desc {
  animation: mxt-desc-reveal 1.2s cubic-bezier(0.16, 1, 0.3, 1) 1.4s both;
}
@keyframes mxt-bubble-pop {
  0% { transform: scale(0); opacity: 0; }
  60% { transform: scale(1.1); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes mxt-title-reveal {
  0% { opacity: 0; transform: translateY(100px) scale(0.9); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes mxt-desc-reveal {
  0% { opacity: 0; transform: translateY(40px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes mxt-curtain-slide {
  0% { transform: translateY(0); opacity: 1; }
  70% { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(-110vh); opacity: 0; visibility: hidden; pointer-events: none; }
}
`;

// Marks the archived intro curtain in a React clone and guarantees the full
// "See life from a different angle" headline is present so the CSS replay above
// animates a real title. Operates on the converted Home JSX; if the expected
// markup is absent the layout is returned untouched.
function enhanceReactIntro(layout: string): string {
  if (!layout.includes("curtain-title")) return layout;
  let out = layout;
  out = out.replace(
    /className="fixed top-0 left-0 w-full h-\[100dvh\] z-100"/,
    `className="fixed top-0 left-0 w-full h-[100dvh] z-100 intro-curtain"`,
  );
  if (!out.includes("different angle")) {
    out = out.replace(
      /(<span[^>]*curtain-title[^>]*>\s*)\{"See life from"\}\s*<br \/>\s*<\/span>/,
      `$1{"See life from"}<br />{" a different angle"}</span>`,
    );
  }
  return out;
}

// The archived Framer router ships a real splat route (`routes/$`, the NotFound
// page) so any URL the crawl did not capture dead-ends on the "The page you're
// looking for doesn't exist." screen. Point that splat at the captured home
// module instead, so unknown paths render the home clone rather than a 404.
function patchManifestSplatToHome(manifestCode: string): string {
  const homeMatch = /"routes\/home":\s*\{[\s\S]*?module:\s*"([^"]+)"/.exec(manifestCode);
  const splatMatch = /"routes\/\$":\s*\{[\s\S]*?module:\s*"([^"]+)"/.exec(manifestCode);
  if (!homeMatch || !splatMatch) return manifestCode;
  if (splatMatch[1] === homeMatch[1]) return manifestCode;
  return manifestCode.split(`module: "${splatMatch[1]}"`).join(`module: "${homeMatch[1]}"`);
}

async function collectExportFiles(
  source: string,
  target: ExportTarget,
  selector?: string,
  language?: ExportLanguage,
) {
  let phaseLast = Date.now();
  const markPhase = (label: string) => {
    const now = Date.now();
    console.log(`[clone-timing] ${label}: ${now - phaseLast}ms`);
    phaseLast = now;
  };
  const requested = validatePublicUrl(source);
  const response = await fetchPublic(requested);
  const finalUrl = validatePublicUrl(response.url || requested.toString());
  const cleaned = absolutizeHtml(cleanSourceHtml(await response.text(), finalUrl, false), finalUrl);
  markPhase("fetch-document");
  const selectedRegion = selectDocumentFragment(cleaned, selector);
  const sourceHtml = selectedRegion.html;
  let downloaded = rewriteTextualAssets(await downloadAssets(sourceHtml, finalUrl), finalUrl);
  markPhase("download-assets");
  const bundled = consolidateBundle(rewriteReferences(sourceHtml, downloaded), downloaded);
  if (bundled.files["js/main.mjs"])
    bundled.files["js/main.mjs"] = rewriteArchiveModuleImports(
      bundled.files["js/main.mjs"],
      downloaded,
    );
  markPhase("consolidate-bundle");

  bundled.html = extractCleanHtml(bundled.html);

  // Strip Framer i18n attributes so text edits in the exported HTML stick, drop
  // wrong video preloads (refresh/cold-load lag) and, for static targets, inject
  // the blank-screen safety net. Produced ahead of the React conversion so the
  // resulting components are also free of i18n attributes.
  bundled.html = makeEditableHtml(bundled.html, target === "static");
  // VSCode flags U+2028/U+2029 in HTML ("Unusual Line Terminators"); the chars
  // come through from the source page's text. Collapse them in the emitted
  // document so editors stop warning (and older browsers stop erroring).
  bundled.html = bundled.html.replace(/[\u2028\u2029]/g, " ");

  const entrySpecRaw =
    /import\s*["']([^"']+)["']/.exec(bundled.files["js/main.mjs"] ?? "")?.[1] ?? "";
  const entryAssetForChunks =
    downloaded.find(
      (asset) => asset.path === entrySpecRaw.replace(/^\/+/, "") || asset.original === entrySpecRaw,
    ) ?? downloaded.find((asset) => /^js\/[^/]+$/.test(asset.path));
  // Basename of the original entry module ("DNBXjO6S.js"). The raw route chunks
  // that Nuxt/Vite ship import named exports straight out of it; the merge folds
  // that code into main.mjs, so those relative imports are rewritten to point at
  // main.mjs instead (whose tail re-exports the entry surface).
  const entryChunkName = entryAssetForChunks?.original
    ? decodeURIComponent(
        new URL(entryAssetForChunks.original).pathname.split("/").pop() ?? "",
      ).replace(/[?#].*$/, "")
    : "";
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rewriteChunkEntryImport = (code: string): string =>
    entryChunkName
      ? code.replace(new RegExp(`["']\\./${escapeRegExp(entryChunkName)}["']`, "g"), '"./main.mjs"')
      : code;

  // The graph merge inlines module source into main.mjs, but file-backed route
  // fragments that stay on disk as separate ESM still import those inlined
  // modules at runtime (their specifiers survive as literal import()/manifest
  // paths). A "removed" module must keep its file whenever any surviving bundle
  // text still names it, or the first lazy route mount 404s at the chunk.
  const removedRetainer = (removed: Set<string>) => {
    const survivingText = [
      bundled.html,
      ...Object.values(bundled.files),
      ...downloaded
        .filter((asset) => asset.textual && /\.m?js(\?|$)/.test(asset.original))
        .map((asset) => new TextDecoder().decode(asset.bytes)),
    ].join("\n");
    return (asset: DownloadedAsset) =>
      !removed.has(asset.path) || survivingText.includes(asset.path.split("/").pop() ?? asset.path);
  };
  const initial = !process.env["WEBCLONER_FOLD"]
    ? null
    : bundleModuleGraph(bundled.files["js/main.mjs"] ?? "", downloaded);
  let merged = initial;
  if (initial) {
    bundled.files["js/main.mjs"] = initial.code;
    const keep = removedRetainer(initial.removed);
    downloaded = downloaded.filter(keep);
  }

  // Dynamic chunks that made it into the merged bundle leave a literal
  // `import("../js/<chunk>.mjs")` the runtime will try to fetch from the
  // archive. When the initial download missed one (or a redeploy changed the
  // CDN layout mid-scan), fetch those exact files by basename and re-merge so
  // the zip stays self-contained.
  if (merged) {
    // Dynamic chunks that survived the merge leave a literal `import("../js/
    // <chunk>.js")` (or a modulepreload string in Nuxt/SvelteKit entry bundles)
    // the runtime will fetch when a route mounts. When the initial download
    // missed one Ã¢â‚¬â€ or a redeploy changed the CDN layout mid-scan Ã¢â‚¬â€ fetch those
    // exact files by basename so the archive stays self-contained.
    // After a fully inlined merge the literal entry import is gone, so anchor
    // chunk lookups on any archived .js asset and finally the document itself.
    const entryAsset =
      entryAssetForChunks ??
      downloaded.find((asset) => /\.m?js(\?|$)/.test(asset.original)) ??
      downloaded.find((asset) => /\/_nuxt\/|\/_next\/|\/_app\//.test(asset.original));
    const chunkBase = entryAsset?.original ?? finalUrl.toString();
    const chunkFetch = async (name: string): Promise<Uint8Array | null> => {
      const url = new URL(name, new URL(chunkBase));
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 200 * attempt * attempt));
        try {
          const candidate = await fetchPublic(url, chunkBase, 0, true);
          const isHtml = (candidate.headers.get("content-type") ?? "").includes("text/html");
          if (!candidate.ok || isHtml) continue;
          const bytes = new Uint8Array(await candidate.arrayBuffer());
          if (bytes.byteLength > MAX_ASSET_BYTES) return null;
          return bytes;
        } catch {
          // Retry; a host that keeps refusing ends the loop below.
        }
      }
      return null;
    };
    const bodiesIn = (): Map<string, string> => {
      const bodies = new Map<string, string>();
      for (const [name, body] of merged?.files ?? new Map()) bodies.set(name, body);
      for (const [name, body] of Object.entries(bundled.files)) {
        if (!name.endsWith(".mjs") && !name.endsWith(".js")) continue;
        bodies.set(name, body);
      }
      return bodies;
    };
    const namesIn = (): Set<string> => {
      const set = new Set(merged?.missing ?? []);
      for (const [name, body] of bodiesIn()) {
        for (const match of body.matchAll(CHUNK_IMPORT)) {
          const spec = match[2]!;
          const base = spec.replace(/^.*\//, "");
          if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|js)$/.test(base)) set.add(base);
        }
        // Nuxt/SvelteKit entry bundles advertise route chunks as strings inside
        // a modulepreload array ("D5jJLml9.js") rather than literal import()
        // calls, so the runtime fetches them by name only when a route mounts.
        // Pull those (plus their CSS entries) in up front so the archive stays
        // self-contained.
        for (const match of body.matchAll(
          /["']\.\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|js|css))["']/g,
        )) {
          set.add(match[1]!);
        }
      }
      return set;
    };
    for (let pass = 0; pass < 6; pass += 1) {
      const wanted = [...namesIn()];
      let fetched = 0;
      const fresh: DownloadedAsset[] = [];
      for (const name of wanted) {
        const present =
          downloaded.some((asset) => asset.path.endsWith(`/js/${name}`)) ||
          bundled.files[`js/${name}`] != null;
        if (present) continue;
        const bytes = await chunkFetch(name);
        if (!bytes) continue;
        fetched += 1;
        const decoded = rewriteChunkEntryImport(new TextDecoder().decode(bytes));
        const origin = new URL(name, new URL(chunkBase)).toString();
        // Stylesheet chunks are not part of the module graph; the runtime emits
        // a <link rel="modulepreload"> for them at mount time, so shipping them
        // as static files next to the JS chunks is enough.
        if (name.endsWith(".css")) {
          bundled.files[`js/${name}`] = decoded;
          continue;
        }
        const patchedBytes = new TextEncoder().encode(decoded);
        fresh.push({ original: origin, path: `js/${name}`, bytes: patchedBytes, textual: true });
        downloaded.push(fresh[fresh.length - 1]!);
        // Keep the chunk on disk even if a later merge pass inlines it, so the
        // archive never depends on how aggressively the graph was consolidated.
        bundled.files[`js/${name}`] = decoded;
      }
      if (fresh.length) {
        const remerged = bundleModuleGraph(bundled.files["js/main.mjs"] ?? "", downloaded);
        // A chunk that refuses to merge (import.meta, odd export forms, ...) can
        // abort the graph, but the loop may keep discovering sibling chunks from
        // the raw files already archived Ã¢â‚¬â€ do not let one bad merge starve the
        // remaining passes.
        if (remerged) {
          merged = remerged;
          downloaded = downloaded.filter(removedRetainer(remerged.removed));
        }
      }
      if (!fetched) break;
    }
    // The entry module was inlined into the weaver bundle, but raw route chunks
    // that ship as plain ESM still import named exports straight out of it
    // (`import { $ } from "./<entry>.js"`). Site-cloner rewrites those to
    // `./main.mjs`, so the merged bundle must re-export that surface.
    bundled.files["js/main.mjs"] =
      merged!.code + buildEntryExportsSuffix(entryAssetForChunks ?? null, entrySpecRaw);
    for (const [path, code] of merged!.files) {
      bundled.files[path] = /\.(?:mjs|js)$/.test(path) ? rewriteChunkEntryImport(code) : code;
    }
  }
  markPhase("chunk-fetch-and-merge");
  // Media that is referenced only from late-fetched route chunks (public-asset
  // manifests, showreel/filmstrip videos, ...) never reaches the HTML crawler,
  // because those files are pulled in after the crawl finishes. Sweep the
  // collected bundle text for object URLs the runtime could still resolve at
  // their exact origin pathname and archive the missing ones. The alias self-
  // reference keeps them off the prune list, like the filmstrip frames above.
  {
    const SWEEP_MEDIA =
      /\.(?:mp4|webm|mov|m4v|m4a|mp3|wav|ogg|webp|avif|png|jpe?g|gif|svg|ico|woff2?|ttf|otf)(?:[?#]|$)/i;
    // Lottie/loader JSON animations (assets/lottie/.../intro.json etc.) are
    // referenced only from route chunks merged after the crawl, so they never
    // reach downloadAssets. Sweep those too, but only under asset-ish roots so
    // API/telemetry endpoints stay out of the archive.
    const SWEEP_JSON = /\.json(?:[?#]|$)/i;
    const SWEEP_JSON_ROOT =
      /(?:^|\/)(?:assets|static|media|data|fonts?|uploads?|images?|public)\//i;
    const sweepBase = new URL(entryAssetForChunks?.original ?? finalUrl.toString());
    const byOriginal = new Map(
      downloaded
        .filter((asset) => !asset.textual)
        .map((asset) => [asset.original.split("#")[0], asset]),
    );
    const knownPaths = new Set([
      ...downloaded.map((asset) => asset.path),
      ...Object.keys(bundled.files),
    ]);
    const candidates = new Set<string>();
    const decoder = new TextDecoder();
    // The sweep must also read the archived textual module bodies. Route chunks
    // (Framer layout/root/Program/FAQ/etc.) downloaded during the crawl hold the
    // asset references: bundled.files alone only contains the merged entry bundle,
    // so animation/loader JSONs referenced from those modules would otherwise never
    // be seen (data jsons survive only because their paths match LOCAL_PATH_PATTERN).
    const sweepTexts = [
      ...Object.values(bundled.files),
      ...downloaded
        .filter(
          (asset) =>
            asset.textual &&
            /\.m?js(\?|$)/i.test(asset.original) &&
            (asset.path.startsWith("js/") || asset.path.startsWith("assets/")),
        )
        .map((asset) => decoder.decode(asset.bytes)),
    ];
    for (const body of sweepTexts) {
      for (const url of discoverAssetUrls(body, finalUrl)) {
        const clean = url.split("#")[0] ?? url;
        if (!SWEEP_MEDIA.test(clean) && !(SWEEP_JSON.test(clean) && SWEEP_JSON_ROOT.test(clean)))
          continue;
        const pathname = decodeURIComponent(new URL(clean).pathname.replace(/^\//, ""));
        if (!pathname || knownPaths.has(pathname)) continue;
        candidates.add(clean);
        if (candidates.size >= 3000) break;
      }
      if (candidates.size >= 3000) break;
    }
    for (const url of candidates) {
      const pathname = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
      if (knownPaths.has(pathname)) continue;
      const reused = byOriginal.get(url);
      if (reused) {
        downloaded.push({ ...reused, path: pathname, aliases: [pathname] });
        knownPaths.add(pathname);
        continue;
      }
      let bytes: Uint8Array | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 200));
        try {
          const response = await fetchPublic(new URL(url), sweepBase.toString(), 0, true);
          if (response.ok && !(response.headers.get("content-type") ?? "").includes("text/html")) {
            const bodyBytes = new Uint8Array(await response.arrayBuffer());
            if (bodyBytes.byteLength <= MAX_ASSET_BYTES) bytes = bodyBytes;
          }
        } catch {
          // Transient failure; retry once more below.
        }
        if (bytes) break;
      }
      if (!bytes) continue;
      downloaded.push({
        original: url,
        path: pathname,
        bytes,
        textual: false,
        aliases: [pathname],
      });
      knownPaths.add(pathname);
    }
  }
  markPhase("media-sweep");
  // Vite rewrites component asset imports into `new URL("<basename>", import.meta.url)`.
  // The origin serves those assets as siblings of the module (under /_nuxt/), so
  // the browser resolves them against the module's own directory. The archive
  // flattens origin modules under js/, which silently moved media like the
  // hero-brand logos and project case-study images out of reach. Archive the
  // same basename beside the module: reuse the downloaded copy when one exists,
  // otherwise pull the origin's sibling file (same /_nuxt/ folder as the module).
  const siblingMedia =
    /\.(svg|webp|png|jpe?g|gif|avif|mp4|webm|mov|m4v|mp3|wav|ogg|woff2?|ttf|otf)(?:[?#]|$)/i;
  // The downloader prefixes disk names with a content hash ("05a89e9e-name.svg"),
  // so match basenames on their hash-stripped form.
  const siblingKey = (name: string) => name.replace(/^[0-9a-f]{8}-/i, "");
  const siblingByBasename = new Map<string, DownloadedAsset>();
  for (const asset of downloaded) {
    const name = asset.path.split("/").pop()!;
    if (name) siblingByBasename.set(siblingKey(name), asset);
  }
  const siblingModuleRe =
    /new\s+URL\(\s*["'`]([^"'`/\\]{4,140})["'`]\s*,\s*import\.meta\.url\s*\)/g;
  const siblingExports: Array<[DownloadedAsset, string]> = [];
  const siblingAliasPaths = new Set<string>();
  // Vite lazy-component chunks advertise their own CSS/JS siblings through a
  // `__vite__mapDeps` table whose entries are bare relative names
  // (`"./BFluid.bxahTSu7.css"`, `"./entry.2V6dYgIy.css"`). The runtime injects
  // them as `import("./<name>")` / preload <link>s, resolved against the module's
  // own /_nuxt/ directory. Archive each beside the module (js/<name>) so layout
  // CSS and per-route images never 404 offline.
  const viteDepRe =
    /["']\.\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:css|js|mjs|webp|png|jpe?g|gif|avif|svg))["']/g;
  // Scan both the merged entry files and every raw archived chunk body: the raw
  // Nuxt/Vite route chunks carry the references, and they never enter bundled.files.
  const siblingModuleSources: Array<[string, string]> = [
    ...Object.entries(bundled.files).filter(([p]) => p.startsWith("js/")),
    ...downloaded
      .filter((asset) => asset.textual && /\.m?js(\?|$)/i.test(asset.original))
      .map((asset) => [asset.path, new TextDecoder().decode(asset.bytes)] as [string, string]),
  ];
  const seenSiblingRequests = new Set<string>();
  const fetchSibling = async (nuxtName: string): Promise<Uint8Array | null> => {
    const key = `/_nuxt/${nuxtName}`;
    if (seenSiblingRequests.has(key)) return null;
    seenSiblingRequests.add(key);
    const originSibling = new URL(key, finalUrl);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        const response = await fetchPublic(originSibling, finalUrl.toString(), 0, true);
        if (response.ok && !(response.headers.get("content-type") ?? "").includes("text/html")) {
          const bodyBytes = new Uint8Array(await response.arrayBuffer());
          if (bodyBytes.byteLength && bodyBytes.byteLength <= MAX_ASSET_BYTES) return bodyBytes;
        }
      } catch {
        // Sibling may not exist on the origin; skip.
      }
    }
    return null;
  };
  for (const [modulePath, code] of siblingModuleSources) {
    if (!modulePath.startsWith("js/")) continue;
    const siblingDir = modulePath.slice(0, modulePath.lastIndexOf("/") + 1);
    // A) `new URL("<basename>", import.meta.url)` asset imports.
    for (const match of code.matchAll(siblingModuleRe)) {
      const basename = match[1];
      if (!basename || !siblingMedia.test(basename)) continue;
      const alias = siblingDir + basename;
      if (downloaded.some((asset) => asset.path === alias)) continue;
      siblingAliasPaths.add(alias);
      const existing = siblingByBasename.get(siblingKey(basename));
      if (existing) {
        siblingExports.push([existing, alias]);
        continue;
      }
      const bytes = await fetchSibling(basename);
      if (!bytes) continue;
      downloaded.push({
        original: new URL(`/_nuxt/${encodeURIComponent(basename)}`, finalUrl).toString(),
        path: alias,
        bytes,
        textual: /\.(?:css|js|mjs)$/i.test(basename),
        aliases: [alias],
      });
    }
    // B) `__vite__mapDeps` sibling names (bare "./<name>") Ã¢â€ â€™ js/<name>.
    for (const match of code.matchAll(viteDepRe)) {
      const basename = match[1]!;
      const alias = siblingDir + basename;
      if (downloaded.some((asset) => asset.path === alias) || bundled.files[alias] != null)
        continue;
      if (siblingAliasPaths.has(alias)) continue;
      siblingAliasPaths.add(alias);
      const existing = siblingByBasename.get(siblingKey(basename));
      if (existing) {
        siblingExports.push([existing, alias]);
        continue;
      }
      const bytes = await fetchSibling(basename);
      if (!bytes) continue;
      downloaded.push({
        original: new URL(`/_nuxt/${encodeURIComponent(basename)}`, finalUrl).toString(),
        path: alias,
        bytes,
        textual: /\.(?:css|js|mjs)$/i.test(basename),
        aliases: [alias],
      });
    }
  }
  for (const [existing, alias] of siblingExports) {
    if (downloaded.some((asset) => asset.path === alias)) continue;
    downloaded.push({ ...existing, path: alias, aliases: [alias] });
  }
  markPhase("sibling-assets");
  // Runtime-built media URLs (filmstrip frames, canvas sprites, shader screens,
  // ...) are assembled from snippets, so no static reference survives rewrites.
  // When an archived asset is not reachable through any rewritten path, store it
  // at its decoded origin pathname so those concatenated URLs resolve offline.
  //
  // Route chunks archived under js/ are NOT part of bundled.files (which only
  // holds the merged entry + stylesheet), yet they are the ones holding the
  // references to per-route media: max's LineImage module points its SVG <image>
  // at `../assets/images/<hash>-illu-3-to-18.webp`, and a chunk-local reference the
  // prune pass cannot see makes that illustration vanish. Fold every archived
  // textual body (chunks, JSON payloads, stylesheets) into the reference/keep set.
  const archivedTexts = downloaded
    .filter((asset) => asset.textual)
    .map((asset) => new TextDecoder().decode(asset.bytes));
  const allTexts = [bundled.html, ...Object.values(bundled.files), ...archivedTexts];
  const referencedPaths = new Set<string>();
  for (const text of allTexts) {
    for (const match of text.matchAll(LOCAL_PATH_PATTERN)) referencedPaths.add(match[0]);
  }
  // The js/-sibling media above is only reachable at runtime (resolved against
  // the local module URL), so it has no static reference: protect those paths
  // from being remapped onto their origin pathname.
  for (const alias of siblingAliasPaths) referencedPaths.add(alias);
  downloaded = downloaded.map((asset) => {
    if (asset.textual || referencedPaths.has(asset.path)) return asset;
    try {
      const alias = decodeURIComponent(new URL(asset.original).pathname.replace(/^\//, ""));
      if (!alias || alias === asset.path || alias.includes("..")) return asset;
      return { ...asset, path: alias, aliases: [alias] };
    } catch {
      return asset;
    }
  });

  let assets = pruneUnusedAssets(downloaded, allTexts);
  markPhase("prune-assets");
  if (selectedRegion.region) {
    // Section export: the cropped HTML only knows about the selected region, and
    // CSS owns its fonts/styling, but the merged Framer bundle walks the whole
    // site's data (the region's own media is only reachable through js/main.mjs,
    // never the cropped page), so every section's media pollutes the archive.
    // Re-scope the kept set to the region (page + stylesheets + the merged
    // bundle) plus fonts. For Framer the bundle itself must be the source of
    // truth or the selected section's own components 404 at runtime.
    const scoped = new Set<string>();
    for (const [path, code] of Object.entries(bundled.files)) {
      if (!path.startsWith("css/") && !path.startsWith("js/")) continue;
      for (const match of code.matchAll(LOCAL_PATH_PATTERN)) scoped.add(match[0]);
    }
    for (const match of bundled.html.matchAll(LOCAL_PATH_PATTERN)) scoped.add(match[0]);
    assets = assets.filter(
      (asset) => scoped.has(asset.path) || asset.path.startsWith("assets/fonts/"),
    );
  }

  // React targets relocate media under public/<kind>/ and merge every
  // stylesheet into the bundler's own CSS entry (src/index.css / app/globals.css).
  if (target !== "static") {
    bundled.html = remapAssetPaths(bundled.html);
    for (const path of Object.keys(bundled.files)) {
      bundled.files[path] = remapAssetPaths(bundled.files[path]!);
    }
    assets = assets.map((asset) => ({ ...asset, path: remapAssetPaths(asset.path) }));
  }

  // Runtime-booted frameworks (Nuxt injects its <link> tags after reading a
  // build manifest we cannot reproduce offline) would render the clone with no
  // stylesheet at all. Link every captured CSS chunk directly in the head so
  // the archived layout applies regardless of whether the runtime boots.
  let chunkCss: string[] = [];
  {
    const headCss = new Set(
      [...parseHtml(bundled.html, PARSE_OPTIONS).querySelectorAll("link[rel=stylesheet]")].map(
        (node) => node.getAttribute("href") ?? "",
      ),
    );
    chunkCss = [
      ...new Set([...assets.map((asset) => asset.path), ...Object.keys(bundled.files)]),
    ].filter((path) => path.endsWith(".css") && !headCss.has(`/${path}`));
    if (chunkCss.length) {
      chunkCss.sort((a, b) => {
        const ae = /^js\/entry\./.test(a);
        const be = /^js\/entry\./.test(b);
        return ae === be ? a.localeCompare(b) : ae ? -1 : 1;
      });
      const links = chunkCss.map((path) => `<link rel="stylesheet" href="/${path}">`).join("");
      const root = parseHtml(bundled.html, PARSE_OPTIONS);
      const head = root.querySelector("head");
      if (head) head.insertAdjacentHTML("beforeend", links);
      bundled.html = root.toString();
    }
  }

  // Full-page mounting frameworks (Nuxt) rebuild the whole app into their own
  // root (#__nuxt) from a per-deploy build manifest. Stripping that runtime kept
  // the SSR markup but froze every animation; instead archive the boot endpoints
  // (build manifest, route payload, i18n messages) verbatim from the origin so
  // the app hydrates the exact same DOM offline. Absolute paths resolve under
  // the archive: static servers, Vite and Next serve them from the folder root
  // (query strings such as ?<buildId> are ignored when mapping to a file).
  const isNuxt = isFullPageRuntimeApp(bundled.html);
  if (isNuxt) {
    const tryAdd = async (path: string): Promise<string | null> => {
      try {
        const url = new URL(path, finalUrl);
        const response = await fetchPublic(url, finalUrl.toString(), 0, true);
        if (!response.ok) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.byteLength || bytes.byteLength > MAX_ASSET_BYTES) return null;
        // Keep the path slashless like every other archive asset; the emit loop
        // puts it under public/ via assetPrefix.
        const clean = path.replace(/^\//, "");
        assets.push({ original: url.toString(), path: clean, bytes, textual: true });
        return new TextDecoder().decode(bytes);
      } catch {
        return null;
      }
    };
    let buildId = "";
    try {
      const manifest = await tryAdd("/_nuxt/builds/latest.json");
      buildId = (JSON.parse(manifest ?? "{}") as { id?: string }).id ?? "";
    } catch {
      buildId = "";
    }
    if (buildId) await tryAdd(`/_nuxt/builds/meta/${buildId}.json`);
    await tryAdd("/_payload.json");
    // vue-i18n lazy-fetches per-locale message bundles from /_i18n/<hash>/...;
    // discover the hash from the pre-prune bundle text (the chunk that templates
    // the URL is often pruned from the final set) and pull the locales the
    // document declares.
    const mainCode = [
      bundled.html,
      ...Object.values(bundled.files),
      ...downloaded
        .filter((asset) => asset.textual)
        .map((asset) => new TextDecoder().decode(asset.bytes)),
    ].join("\n");
    const i18nBases = [
      ...new Set([
        ...[...mainCode.matchAll(/\/_i18n\/([A-Za-z0-9_-]+)\//g)].map((match) => match[1]),
        // vue-i18n keys message bundles by a hash; for an empty message set the
        // hash is SHA-256 of "" (= "e3b0c442"), which the regex cannot catch if
        // the URL is built dynamically. Pulling it as a fallback silences the
        // runtime's fetch-and-404 for exactly that case.
        "e3b0c442",
      ]),
    ];
    if (i18nBases.length) {
      const locales = new Set<string>(["en"]);
      for (const node of parseHtml(bundled.html, PARSE_OPTIONS).querySelectorAll(
        "html, link[hreflang]",
      )) {
        const lang =
          node.tagName === "HTML" ? node.getAttribute("lang") : node.getAttribute("hreflang");
        if (lang) locales.add(lang.split("-")[0]!.toLowerCase());
      }
      for (const base of i18nBases) {
        for (const locale of locales) await tryAdd(`/_i18n/${base}/${locale}/messages.json`);
      }
    }
    markPhase("nuxt-runtime-support");
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const relative = target === "static";
  const emit = async (path: string, code: string) => {
    const depth = relative ? path.split("/").length - 1 : 0;
    return encoder.encode(
      await formatSource(path, relative ? relativizeLocalPaths(code, depth) : code),
    );
  };

  let files: Record<string, Uint8Array>;

  const emitBundle: Record<string, string> = bundled.files;

  if (target === "static") {
    const html = decoder.decode(await emit("index.html", injectStaticTextOverlay(bundled.html)));
    files = staticFiles(injectStaticBaseTag(html), finalUrl);
  } else {
    const resolvedLanguage: ExportLanguage = language ?? (target === "vite" ? "jsx" : "tsx");
    try {
      const { sections, components, layout } = convertHtmlToReactComponents(
        bundled.html,
        resolvedLanguage,
      );
      const formattedSections = sections.map((s) => ({
        name: s.name,
        filePath: s.filePath,
        code: s.code,
      }));
      const formattedComponents = components.map((c) => ({
        name: c.name,
        filePath: c.filePath,
        code: c.code,
      }));

      // The original "See life from a different angle" intro is Framer Motion
      // driven from the site runtime, which the React mirror cannot boot, so its
      // curtain-title/desc stay opacity-0 and the beige curtain never opens. The
      // markup itself survives the conversion; mark it and let CSS replay the
      // reveal deterministically (see INTRO_CURTAIN_CSS).
      const editedLayout = enhanceReactIntro(layout);

      files =
        target === "vite"
          ? viteFiles(
              bundled.html,
              finalUrl,
              formattedSections,
              editedLayout,
              formattedComponents,
              resolvedLanguage,
            )
          : nextFiles(
              bundled.html,
              finalUrl,
              formattedSections,
              editedLayout,
              formattedComponents,
              resolvedLanguage,
            );
    } catch (error) {
      console.error("Failed to convert HTML to components, using static fallback:", error);
      const html = decoder.decode(await emit("index.html", bundled.html));
      files = staticFiles(html, finalUrl);
    }
  }

  const assetPrefix = target === "static" ? "" : "public/";
  const cssEntry = target === "vite" ? "src/index.css" : "app/globals.css";

  for (const [path, code] of Object.entries(emitBundle)) {
    if (target !== "static" && path === "css/styles.css") {
      // The head <link> tags above (kept as a static fallback) cannot survive
      // the HTML-to-React conversion, so the CSS chunks are imported from the
      // bundler's own entry stylesheet instead. They live under public/js/ and
      // are served at /js/... in both dev and build.
      const imports = chunkCss.map((css) => `@import url("/${css}");`).join("");
      files[cssEntry] = await emit(cssEntry, `${imports}${code}`);
      continue;
    }
    files[`${assetPrefix}${path}`] = await emit(path, code);
  }
  for (const asset of assets) {
    const emitBytes = (path: string) =>
      asset.textual
        ? emit(
            path,
            target === "static"
              ? decoder.decode(asset.bytes)
              : remapAssetPaths(decoder.decode(asset.bytes)),
          )
        : asset.bytes;
    const mainPath = `${assetPrefix}${asset.path}`;
    if (files[mainPath] == null) files[mainPath] = await emitBytes(asset.path);
    for (const alias of asset.aliases ?? []) {
      const aliasPath = target === "static" ? alias : assetPrefix + remapAssetPaths(alias);
      if (files[aliasPath] != null) continue;
      files[aliasPath] = await emitBytes(aliasPath);
    }
  }
  if (target !== "static" && files[cssEntry]) {
    files[cssEntry] = new TextEncoder().encode(decoder.decode(files[cssEntry]) + INTRO_CURTAIN_CSS);
  }
  if (target === "static") {
    // The archived Framer router owns a real `routes/$` splat route that renders
    // the NotFound page ("The page you're looking for doesn't exist.") for any
    // URL the single-page crawl did not capture. Dangling in-page/footer links
    // (privacy, terms, social targets, ...) and typed/refreshed paths then dead-end
    // on it, which reads as a broken clone. Reuse the home route module for the
    // splat so unknown paths render the captured home screen instead.
    for (const [path, bytes] of Object.entries(files)) {
      if (!/^js\/[A-Za-z0-9]+-manifest-[A-Za-z0-9-]+\.js$/.test(path)) continue;
      const patched = patchManifestSplatToHome(decoder.decode(bytes));
      if (patched !== decoder.decode(bytes)) files[path] = new TextEncoder().encode(patched);
    }
    // Split the single merged stylesheet into per-section files loaded in the same
    // order (cascade-safe), so the archive reads like a hand-authored project.
    splitStaticStylesheets(files);
  }
  return files;
}

export async function buildExport(
  source: string,
  target: ExportTarget,
  selector?: string,
  language?: ExportLanguage,
) {
  return zipSync(await collectExportFiles(source, target, selector, language), { level: 6 });
}

// Already-compressed media gains nothing from deflate; storing it keeps CPU and
// memory inside the Worker budget, which is what turned large exports into a
// dropped connection ("Failed to fetch") in the browser.
const STORE_ONLY = /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov|m4v|mp3|wav|ogg|woff2?|zip|ico)$/i;

// Streams the archive out entry by entry instead of buffering a full ZIP copy.
export async function buildExportStream(
  source: string,
  target: ExportTarget,
  selector?: string,
  language?: ExportLanguage,
) {
  const files =
    target === "static" && selector == null && language == null
      ? await getPreviewFiles(source)
      : await collectExportFiles(source, target, selector, language);
  const entries = Object.entries(files);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      const zip = new Zip((error, chunk, final) => {
        if (error) {
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });

      try {
        for (const [path, bytes] of entries) {
          const entry = STORE_ONLY.test(path)
            ? new ZipPassThrough(path)
            : new ZipDeflate(path, { level: 6 });
          zip.add(entry);
          entry.push(bytes, true);
          entries[index++] = ["", new Uint8Array()];
        }
        zip.end();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}


