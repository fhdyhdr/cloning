import { createFileRoute } from "@tanstack/react-router";
import {
  buildPreview,
  buildPreviewAsset,
  getPreviewFiles,
  previewReady,
  previewSplashHtml,
  previewSourceFromKey,
  startPreviewBuild,
} from "@/lib/site-cloner.server";

function decodeId(raw: string) {
  try {
    const source = previewSourceFromKey(raw);
    // A decodable id must look like a URL; otherwise "assets" or other plain
    // path segments would decode to junk and trigger an accidental build.
    return /^https?:\/\//i.test(source) ? source : null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/public/clone/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const splat = (params as { _splat?: string })._splat ?? "";
        const slash = splat.indexOf("/");
        const id = slash === -1 ? splat : splat.slice(0, slash);
        const assetPath = slash === -1 ? "" : decodeURIComponent(splat.slice(slash + 1));
        let source = decodeId(id);
        // Some runtimes (Framer) compute asset URLs as "../assets/…" against the
        // document base, which pops the <id> segment and lands on
        // /api/public/clone/assets/…. Recover the id from the same-origin
        // Referer, and restate the whole splat as the asset path (the first
        // segment was consumed by id parsing but belongs to the file itself).
        let fallback = false;
        if (!source) {
          const referer = request.headers.get("referer");
          const match = referer ? /\/api\/public\/clone\/([^/]+)\//.exec(referer) : null;
          const recovered = match ? decodeId(match[1] ?? "") : null;
          if (recovered) {
            source = recovered;
            fallback = true;
          }
        }
        if (!source) return new Response("Not found", { status: 404 });
        const effectiveAssetPath = fallback ? splat : assetPath;
        try {
          if (!assetPath) {
            if (!previewReady(source)) {
              if (request.headers.get("x-preview-await") !== null) {
                // Splash long-poll: resolve only when the shared static build
                // finishes (or fails) so the browser paints once, not a loop.
                await getPreviewFiles(source);
              } else {
                startPreviewBuild(source);
                return new Response(previewSplashHtml(), {
                  headers: {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Content-Security-Policy": "frame-ancestors 'self'",
                  },
                });
              }
            }
            const html = await buildPreview(source);
            return new Response(html, {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy": "frame-ancestors 'self'",
              },
            });
          }
          const asset = await buildPreviewAsset(source, effectiveAssetPath);
          if (!asset) return new Response("Not found", { status: 404 });
          return new Response(asset.bytes as unknown as BodyInit, {
            headers: {
              "Content-Type": asset.type,
              "Cache-Control": "public, max-age=3600",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } catch (error) {
          return new Response("Preview gagal diproses.", { status: 502 });
        }
      },
    },
  },
});
