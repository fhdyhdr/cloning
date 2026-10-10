import { createFileRoute } from "@tanstack/react-router";
import { previewBaseUrl, validatePublicUrl } from "@/lib/site-cloner.server";

export const Route = createFileRoute("/api/public/clone-preview")({
  server: {
    handlers: {
      // The preview lives at /api/public/clone/<id>/, where relative asset paths
      // resolve same-origin against the cached static archive (no CORS-blocked
      // origin scripts/fonts). This legacy endpoint just redirects there.
      GET: async ({ request }) => {
        try {
          const source = new URL(request.url).searchParams.get("url");
          if (!source) return new Response("Parameter url diperlukan.", { status: 400 });
          const requested = validatePublicUrl(source);
          return new Response(null, {
            status: 302,
            headers: {
              Location: previewBaseUrl(requested.toString()),
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Clone gagal diproses.";
          return new Response(`<h1>Preview gagal</h1><p>${message.replace(/[<>&]/g, "")}</p>`, {
            status: 502,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      },
    },
  },
});
