// ---------------------------------------------------------------------------
// Module graph bundling: Framer ships one module per chunk (js/<hash>.js), so a
// static export ends up with dozens of near-identical scripts. When the
// document loads a single entry module (js/main.mjs), this collapses the whole
// reachable graph into that one file behind a tiny require() runtime and the
// per-chunk files leave the archive.
//
// A faithful merge requires that every reachable module contains nothing that
// cannot be inlined (bare or remote static imports, `export default`,
// `export *`, `import.meta`, dynamic imports with a computed specifier, cycles
// or top-level name clashes) â€” any of those aborts and the original files ship
// untouched. One deliberate exception: a statically imported file that is
// *missing* locally (Framer's `./framer.mjs` app shell is never downloaded)
// binds to an empty namespace. That turns today's all-or-nothing module failure
// into per-module graceful degradation, which is strictly closer to the
// original site.
// ---------------------------------------------------------------------------

type BundleAsset = { path: string; bytes: Uint8Array; textual: boolean };

type Binding = { local: string; host: string; key: string };
type ExportRef = { imported: string; exported: string };

type Compiled = {
  bindings: Binding[];
  deps: string[];
  dynamicDeps: string[];
  code: string;
  exports: ExportRef[];
  dynamic: Map<string, string>;
};

type Result = { code: string; removed: Set<string>; files: Map<string, string>; missing: string[] };

const IMPORT_FROM = /import\s*([^"'`]+?)\s*from\s*["'`]([^"'`]+)["'`]\s*;?/g;
const IMPORT_SIDE_EFFECT = /import\s*["'`]([^"'`]+)["'`]\s*;?/g;
const IMPORT_DYNAMIC = /import\s*\(([\s\S]*?)\)/g;
const EXPORT_FROM = /export\s*\{([\s\S]*?)\}\s*from\s*["'`]([^"'`]+)["'`]\s*;?/g;
const EXPORT_BRACE = /export\s*\{([\s\S]*?)\}\s*;?/g;
const EXPORT_DECL = /export\s+(?:(?:async\s+)?(?:const|let|var|function|class))\s*[A-Za-z_$]/g;
const CHUNK_IMPORT = /import\(\s*(['"`])([^'"`]+)\1\s*\)/g;
const CHUNK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|js)$/;
const RESIDUAL_EXPORT = /(?<![A-Za-z0-9_$.`'"{(,)])export\b/;

// Blanks string/template literals and comments (keeping positions) so keyword
// scans do not trip over decorative `export` occurrences inside text.
function stripLiterals(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < n; j++) if (out[j] !== "\n" && out[j] !== "\r") out[j] = " ";
  };
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "`") {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function splitNames(list: string): ExportRef[] {
  const refs: ExportRef[] = [];
  for (const item of list.split(",")) {
    const name = item.trim();
    if (!name) continue;
    const at = name.indexOf(" as ");
    refs.push(
      at === -1
        ? { imported: name, exported: name }
        : { imported: name.slice(0, at).trim(), exported: name.slice(at + 4).trim() },
    );
  }
  return refs;
}

// True when `/` at position i opens a regex literal (the previous significant
// character is an operator or opening bracket, not an identifier/close/number).
function isRegexStart(code: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /[\s\r\n]/.test(code.slice(j, j + 1))) j -= 1;
  if (j < 0) return true;
  return !/[A-Za-z0-9_$)}\])'"`]/.test(code.slice(j, j + 1));
}

// Collects only declarations at brace depth 0, so minified modules (which
// legally reuse an imported alias inside nested closures) are not falsely
// flagged. Strings, comments and template contents are skipped.
function topLevelDeclarations(code: string): Set<string> {
  const out = new Set<string>();
  const keyword = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
  const window = code.length;
  let depth = 0;
  let quote: string | null = null;
  let templateBrace = 0;
  let i = 0;
  while (i < window) {
    const ch = code[i];
    const next = code[i + 1];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (quote !== "`") {
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (templateBrace === 0 && ch === "`") {
        quote = null;
        i += 1;
        continue;
      }
      if (templateBrace === 0 && ch === "$" && next === "{") {
        templateBrace = 1;
        i += 2;
        continue;
      }
      if (templateBrace > 0) {
        if (ch === "{") templateBrace += 1;
        else if (ch === "}") templateBrace -= 1;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < window && code[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < window && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "/" && next !== "/" && isRegexStart(code, i)) {
      let k = i + 1;
      let inClass = false;
      while (k < window) {
        if (code[k] === "\\") {
          k += 2;
          continue;
        }
        if (code[k] === "[") {
          inClass = true;
          k += 1;
          continue;
        }
        if (code[k] === "]") {
          inClass = false;
          k += 1;
          continue;
        }
        if (code[k] === "\n") break;
        if (code[k] === "/" && !inClass) break;
        k += 1;
      }
      if (k < window && code[k] === "/") {
        i = k + 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0) {
      const match = keyword.exec(code.slice(i, i + 24));
      if (match?.[1]) {
        const kw = match[0].split(/\s+/)[0];
        if (kw === "function" || kw === "class") {
          let j = i - 1;
          const prevBefore = (k: number): string => (k < 0 ? ";" : code.slice(k, k + 1));
          while (j >= 0 && /[\s\r\n]/.test(code.slice(j, j + 1))) j -= 1;
          let prev = prevBefore(j);
          // `async function name` reads ahead to the `async` keyword.
          const asyncBefore =
            j >= 5 && code.slice(j - 5, j) === "async" && !/[A-Za-z0-9_$]/.test(prevBefore(j - 6));
          if (asyncBefore) prev = ";";
          // `X = class e { ... }` / `X = function e() {}` bind only the inner
          // name, not a module-level declaration.
          if (!/[;}{]/.test(prev)) {
            i += match[0].length;
            continue;
          }
        }
        out.add(match[1]);
        i += match[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

function stemMatch(base: string, local: Map<string, string>): string | null {
  const stem = base.replace(/\.(?:mjs|js)$/, "");
  if (stem.length < 8 || !stem.includes(".")) return null;
  for (const candidate of local.keys()) {
    if (candidate !== base && /^[A-Za-z0-9._-]+$/.test(candidate) && candidate.includes(stem)) {
      return `js/${candidate}`;
    }
  }
  return null;
}

function resolveSpecName(spec: string, local: Map<string, string>): string | null {
  // Absolute/parent-path forms must still resolve against the downloaded file
  // set: an old content-hashed chunk name (e.g. `../js/PX9hIOIVM.GY6z_tlq.mjs`)
  // that does not exist locally falls back to a stem match so the rewritten
  // specifier points at the copy that actually shipped.
  if (/^\.\.\/js\/[A-Za-z0-9._-]+$/.test(spec)) {
    const base = spec.slice("../js/".length);
    if (local.has(base)) return `js/${base}`;
    return stemMatch(base, local);
  }
  if (/^\/js\/[A-Za-z0-9._-]+$/.test(spec)) {
    const base = spec.slice("/js/".length);
    if (local.has(base)) return `js/${base}`;
    return stemMatch(base, local);
  }
  const base = spec.replace(/^.*\//, "");
  if (/^[A-Za-z0-9._-]+$/.test(base) && local.has(base)) return `js/${base}`;
  return stemMatch(base, local);
}

function rewriteModule(path: string, source: string, local: Map<string, string>): Compiled {
  const hostOf = (spec: string): string | null => resolveSpecName(spec, local);

  let body = source;
  const dynamic = new Map<string, string>();
  const dynamicSet = new Set<string>();
  const dynamicDeps: string[] = [];
  const dynamicMatches = [...body.matchAll(IMPORT_DYNAMIC)];
  for (let index = dynamicMatches.length - 1; index >= 0; index--) {
    const match = dynamicMatches[index]!;
    const arg = match[1]!.trim();
    const literal = /^(["'`])([\s\S]*?)\1$/.exec(arg);
    // A computed specifier (or a template literal with interpolation) cannot be
    // mapped into the registry; keep the original dynamic import, which resolves
    // from the same /js/ directory whether or not this module is bundled.
    if (!literal || (literal[1] === "`" && literal[2]!.includes("${"))) continue;
    const token = `__WEAVER_DYN_${dynamic.size}__`;
    dynamic.set(token, match[0] ?? "");
    const spec = /["'`]([^"'`]+)["'`]/.exec(match[0] ?? "")?.[1] ?? "";
    const target = hostOf(spec);
    if (target && target !== path && !dynamicSet.has(target)) {
      if (local.has(target.slice("js/".length))) {
        dynamicSet.add(target);
        dynamicDeps.push(target);
      }
    }
    body = body.slice(0, match.index) + token + body.slice(match.index + match[0].length);
  }

  const bindings: Binding[] = [];
  const deps: string[] = [];
  const cuts: [number, number][] = [];
  const addCut = (start: number, end: number) => cuts.push([start, end]);
  const fromSpec = (spec: string): string | null => {
    const host = hostOf(spec);
    if (host) {
      if (host === path) throw new Error(`self import in ${path}`);
      if (!deps.includes(host)) deps.push(host);
    }
    return host;
  };
  const pushBinding = (exported: string, host: string | null, key: string) => {
    bindings.push({ local: exported, host: host ?? "__missing__", key });
  };

  for (const match of body.matchAll(IMPORT_SIDE_EFFECT)) {
    addCut(match.index, match.index + match[0].length);
    fromSpec(match[1]!);
  }
  for (const match of body.matchAll(IMPORT_FROM)) {
    addCut(match.index, match.index + match[0].length);
    const list = match[1]!.trim();
    const spec = match[2]!;
    const host = fromSpec(spec);
    if (!list) throw new Error(`import form in ${path}`);
    if (list.startsWith("*")) {
      const as = /^\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(list)?.[1];
      if (!as) throw new Error(`namespace import in ${path}`);
      pushBinding(as, host, "*");
    } else if (list.startsWith("{")) {
      for (const ref of splitNames(list.slice(1, -1)))
        pushBinding(ref.exported, host, ref.imported);
    } else {
      const mixed = /^([A-Za-z_$][\w$]*)\s*,?\s*\{([\s\S]*)\}$/.exec(list);
      if (mixed?.[1] && mixed[2] !== undefined) {
        pushBinding(mixed[1], host, "default");
        for (const ref of splitNames(mixed[2])) pushBinding(ref.exported, host, ref.imported);
      } else {
        pushBinding(list, host, "default");
      }
    }
  }

  const exports: ExportRef[] = [];
  const exportedFrom = new Set<number>();
  for (const match of body.matchAll(EXPORT_FROM)) {
    exportedFrom.add(match.index);
    addCut(match.index, match.index + match[0].length);
    const host = fromSpec(match[2]!);
    for (const ref of splitNames(match[1]!)) {
      pushBinding(ref.exported, host, ref.imported);
      exports.push(ref);
    }
  }
  for (const match of body.matchAll(EXPORT_BRACE)) {
    if (exportedFrom.has(match.index)) continue;
    addCut(match.index, match.index + match[0].length);
    exports.push(...splitNames(match[1]!));
  }
  for (const match of body.matchAll(EXPORT_DECL)) {
    const after = body.slice(match.index + match[0].length);
    const name = /^[A-Za-z_$][\w$]*/.exec(after)?.[0];
    if (!name) throw new Error(`export form in ${path}`);
    addCut(match.index, match.index + "export ".length);
    exports.push({ imported: name, exported: name });
  }
  cuts.sort((a, b) => b[0] - a[0]);
  let code = body;
  for (const [start, end] of cuts) code = code.slice(0, start) + code.slice(end);
  const RESIDUAL_EXPORT = /(?<![A-Za-z0-9_$.`'"{(,)])export\b/;
  const stripped = stripLiterals(code);
  if (RESIDUAL_EXPORT.test(stripped)) {
    const hit = RESIDUAL_EXPORT.exec(stripped);
    console.error(
      "[rw] unhandled export in",
      path,
      JSON.stringify(code.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 60)),
    );
    throw new Error(`unhandled export in ${path}`);
  }

  const declared = topLevelDeclarations(code);
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (declared.has(binding.local)) throw new Error(`clash on ${binding.local} in ${path}`);
    if (seen.has(binding.local)) throw new Error(`duplicate binding ${binding.local} in ${path}`);
    seen.add(binding.local);
  }

  return { bindings, deps, dynamicDeps, code, exports, dynamic };
}

export function bundleModuleGraph(entryCode: string, assets: BundleAsset[]): Result | null {
  try {
    const decoder = new TextDecoder();
    const local = new Map<string, string>();
    for (const asset of assets) {
      if (!asset.textual) continue;
      const match = /^js\/([A-Za-z0-9._-]+)$/.exec(asset.path);
      if (match?.[1]) local.set(match[1], decoder.decode(asset.bytes));
    }
    if (!entryCode.trim()) return null;

    const compiled = new Map<string, Compiled>();
    const compile = (path: string): void => {
      if (compiled.has(path)) return;
      const body = path === "__entry__" ? entryCode : local.get(path.slice("js/".length));
      if (body === undefined) return;
      const result = rewriteModule(path, body, local);
      compiled.set(path, result);
      for (const dep of result.deps) compile(dep);
    };
    compile("__entry__");
    if (compiled.size < 2) return null;

    // Lazy route and shared chunks only arrive through dynamic imports. Pull
    // them into the bundle too, but a chunk that refuses to merge (like the
    // editor using import.meta) simply stays a file with its import() intact.
    let grew = true;
    let wguard = 0;
    while (grew && wguard++ < 200) {
      grew = false;
      for (const dep of [...compiled.values()].flatMap((record) => record.dynamicDeps)) {
        if (compiled.has(dep)) continue;
        if (local.get(dep.slice("js/".length)) === undefined) continue;
        const before = [...compiled.keys()];
        try {
          compile(dep);
          grew = true;
        } catch {
          for (const key of [...compiled.keys()]) {
            if (before.indexOf(key) === -1) compiled.delete(key);
          }
        }
      }
    }

    const merged = new Set<string>();
    for (const path of compiled.keys()) if (path !== "__entry__") merged.add(path);

    const pieces: string[] = [];
    for (const [path, result] of compiled) {
      const prologue = result.bindings
        .map((binding) =>
          binding.key === "*"
            ? `    var ${binding.local} = __weaverRequire(${JSON.stringify(binding.host)});`
            : `    var ${binding.local} = __weaverRequire(${JSON.stringify(binding.host)}).${binding.key};`,
        )
        .join("\n");
      let code = result.code;
      for (const [token, original] of result.dynamic) {
        const spec = /["'`]([^"'`]+)["'`]/.exec(original)?.[1] ?? "";
        const host = spec ? resolveSpecName(spec, local) : null;
        code = code.replace(
          token,
          host && merged.has(host)
            ? `Promise.resolve().then(function () { return __weaverRequire(${JSON.stringify(host)}); })`
            : host
              ? original.replace(/["'`]([^"'`]+)["'`]/, `"../js/${host.slice("js/".length)}"`)
              : original,
        );
      }
      // The rolldown "fake-ESM" runtime wraps each module in lazy thunks
      // (`var x = t(() => { ... })`) whose getters fire on first access. Our
      // prologue snapshots imports into factory vars, so a thunked export that
      // is read before it has been primed freezes as `undefined`. Reproduce the
      // lazy semantics: run the module's own thunks once, on first export read.
      const thunkArg = result.bindings.find(
        (binding) => binding.key === "t" && /rolldown-runtime/.test(binding.host),
      )?.local;
      const thunks: string[] = [];
      if (thunkArg) {
        const rem = new RegExp(
          `(^|[;\\n,{}])\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*${thunkArg}\\((?:\\s*\\()*\\s*\\)\\s*=>\\s*\\{`,
          "g",
        );
        let rm: RegExpExecArray | null;
        while ((rm = rem.exec(code))) thunks.push(rm[2]!);
      }
      const trailer = result.exports
        .map(
          (ref) =>
            `    Object.defineProperty(exports, ${JSON.stringify(ref.exported)}, { get: function () { ${thunks.length ? "__prime(); " : ""}return ${ref.imported}; }, enumerable: true });`,
        )
        .join("\n");
      const primeDef = thunks.length
        ? `    var __prime = function () { if (__weaverPrimeFlag[${JSON.stringify(path)}]) return; __weaverPrimeFlag[${JSON.stringify(path)}] = true; try { ${thunks.join("(); ")}(); } catch (e) { console.error("PRIMEERR", ${JSON.stringify(path)}, e.message); } };`
        : "";
      const piecesCode = [prologue, code, primeDef, trailer]
        .filter((part) => part !== "")
        .join("\n");
      pieces.push(
        `  __weaverDefine(${JSON.stringify(path)}, ${JSON.stringify(result.deps)}, function (exports) {\n${piecesCode}\n  });`,
      );
    }

    // The merged bundle exposes its module registry (`__weaverRequire`) so the
    // caller can re-export the real entry module's ESM surface: sibling chunks
    // that ship as plain ESM still `import { ... } from "./<entry>.js"`, and
    // site-cloner points those imports at main.mjs.
    const code = `const __weaverRoot = (function () {
  var __weaverDefinitions = Object.create(null);
  var __weaverCache = Object.create(null);
  var __weaverPrimeFlag = Object.create(null);
  function __weaverDefine(id, deps, factory) {
    __weaverDefinitions[id] = { deps: deps, factory: factory };
  }
  function __weaverRequire(id) {
    if (__weaverCache[id]) return __weaverCache[id].exports;
    var record = __weaverDefinitions[id];
    if (!record) { console.error("MISSING_MODULE", id); return (__weaverCache[id] = { exports: {} }); }
    var module = { exports: {} };
    __weaverCache[id] = module;
    var deps = record.deps;
    for (var i = 0; i < deps.length; i++) __weaverRequire(deps[i]);
    record.factory(module.exports, module);
    return module.exports;
  }
  __weaverDefinitions["__missing__"] = { deps: [], factory: function () {} };
${pieces.join("\n")}
  __weaverRequire("__entry__");
  return __weaverRequire;
}());
`;

    const removed = new Set<string>(merged);
    // Files that refuse to merge stay in the archive, but their dynamic imports
    // still point at old content-hashed chunk names (`.mjs`) that no longer
    // exist offline. Rewrite those specifiers to the downloaded names.
    const keptPattern = /(import\s*\(\s*)(["'`])([^"'`]+)\2(\s*\))/g;
    const files = new Map<string, string>();
    for (const [name, body] of local) {
      if (merged.has(`js/${name}`)) continue;
      const patched = body.replace(
        keptPattern,
        (whole, head: string, quote: string, spec: string, tail: string) => {
          const host = resolveSpecName(spec.trim(), local);
          if (host && host !== `js/${spec.replace(/^.*\//, "")}`) {
            return `${head}${JSON.stringify(`../js/${host.slice("js/".length)}`)}${tail}`;
          }
          return whole;
        },
      );
      if (patched !== body) files.set(`js/${name}`, patched);
    }

    // Literal dynamic imports that could not be resolved let the runtime hit the
    // network at a name we did not download. Hand the basenames back to the
    // caller so it can fetch those exact chunks and re-run the merge.
    const missing = new Set<string>();
    for (const match of code.matchAll(CHUNK_IMPORT)) {
      const spec = match[2]!;
      if (!/^\.{0,2}\//.test(spec)) continue;
      const name = spec.replace(/^.*\//, "");
      if (!CHUNK_NAME.test(name) || local.has(name)) continue;
      missing.add(name);
    }
    return { code, removed, files, missing: [...missing] };
  } catch (error) {
    console.error("[bundleModuleGraph] abort:", (error as Error).message);
    return null;
  }
}
