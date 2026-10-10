import { writeFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { buildExport } from "./src/lib/site-cloner.server";

const url = process.env.CLONE_URL ?? "https://shinta.framer.media";
const target = process.env.CLONE_TARGET ?? "vite";
const t0 = Date.now();
const zip = await buildExport(url, target as "static" | "vite" | "next", undefined, "jsx");
const files = unzipSync(zip);
const names = Object.keys(files).sort();
const interesting = names.filter(
  (n) =>
    n.startsWith("src/") ||
    n.startsWith("app/") ||
    n.startsWith("components/") ||
    n.startsWith("hooks/") ||
    n.startsWith("utils/") ||
    n.startsWith("data/") ||
    n === "index.html" ||
    n === "app/globals.css",
);
console.log("URL:", url, "TARGET:", target);
console.log("elapsed(s):", ((Date.now() - t0) / 1000).toFixed(1));
console.log("total entries:", names.length);
console.log("---- interesting ----");
console.log(interesting.join("\n"));
const out = "C:/Users/asus/AppData/Local/Temp/opencode/repro-out.zip";
await writeFile(out, zip);
console.log("wrote:", out);
process.exit(0);