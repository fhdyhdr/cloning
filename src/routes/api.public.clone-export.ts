import { createFileRoute } from "@tanstack/react-router";
import {
  buildExportStream,
  type ExportLanguage,
  type ExportTarget,
} from "@/lib/site-cloner.server";

async function handleExport(url: unknown, target: unknown, selector: unknown, language: unknown) {
  if (typeof url !== "string" || !["static", "vite", "next"].includes(String(target))) {
    return Response.json({ error: "URL dan target export tidak valid." }, { status: 400 });
  }
  const lang = language == null ? undefined : (String(language) as ExportLanguage);
  if (lang !== undefined && !["jsx", "tsx"].includes(lang)) {
    return Response.json({ error: "Bahasa export tidak valid." }, { status: 400 });
  }
  try {
    const stream = await buildExportStream(
      url,
      target as ExportTarget,
      typeof selector === "string" && selector ? selector : undefined,
      lang,
    );
    const hostname = new URL(url).hostname.replace(/[^a-z0-9.-]+/gi, "-");
    return new Response(stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${hostname}-${String(target)}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ZIP gagal dibuat.";
    return Response.json({ error: message }, { status: 502 });
  }
}

export const Route = createFileRoute("/api/public/clone-export")({
  server: {
    handlers: {
      // GET lets the browser download natively: no in-memory blob, no fetch abort.
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams;
        return handleExport(
          params.get("url"),
          params.get("target"),
          params.get("selector"),
          params.get("language"),
        );
      },
      POST: async ({ request }) => {
        const input = (await request.json().catch(() => ({}))) as {
          url?: unknown;
          target?: unknown;
          selector?: unknown;
          language?: unknown;
        };
        return handleExport(input.url, input.target, input.selector, input.language);
      },
    },
  },
});
