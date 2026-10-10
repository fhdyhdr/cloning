import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Code2,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ScanSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Target = "static" | "vite" | "next";
type Lang = "auto" | "jsx" | "tsx";
type Stage = "idle" | "fetching" | "downloading" | "rebuilding" | "ready" | "error";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Site Cloner — Fidelity-first Website Export" },
      {
        name: "description",
        content:
          "Clone public websites into previewable, downloadable Static, Vite, or Next.js projects.",
      },
      { property: "og:title", content: "Site Cloner — Fidelity-first Website Export" },
      {
        property: "og:description",
        content:
          "Clone public sites while preserving their original runtime and responsive behavior.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [url, setUrl] = useState("https://shinta.framer.media");
  const [activeUrl, setActiveUrl] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [message, setMessage] = useState("Ready to clone");
  const [target, setTarget] = useState<Target>("static");
  const [lang, setLang] = useState<Lang>("auto");
  const [downloading, setDownloading] = useState(false);

  // Live-preview mode: the iframe loads the original site directly (fast, like
  // the very first iteration). The heavy static build only runs on Download.
  useEffect(() => {
    if (!activeUrl) return;
    const timer = window.setTimeout(() => {
      setStage((current) => (current === "ready" || current === "error" ? current : "ready"));
      setMessage((current) =>
        current.startsWith("Preview ready") ? current : "Preview ready — export available",
      );
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [activeUrl]);

  const startClone = () => {
    try {
      const normalized = new URL(url).toString();
      setStage("fetching");
      setMessage("Loading live preview…");
      setActiveUrl(normalized);
    } catch {
      setStage("error");
      setMessage("Enter a complete public URL, including https://");
    }
  };

  // The browser downloads the streamed ZIP directly: no blob buffering in the
  // tab and no aborted fetch, which is what surfaced as "Failed to fetch".
  const download = () => {
    if (!activeUrl) return;
    const params = new URLSearchParams({ url: activeUrl, target });
    if (lang !== "auto") params.set("language", lang);
    setDownloading(true);
    setMessage("Building ZIP on the server — the download starts automatically…");
    const anchor = document.createElement("a");
    anchor.href = `/api/public/clone-export?${params.toString()}`;
    anchor.rel = "noopener";
    anchor.click();
    window.setTimeout(() => {
      setDownloading(false);
      setMessage("ZIP download started — check your browser downloads");
    }, 2500);
  };

  const busy = ["fetching", "downloading", "rebuilding"].includes(stage);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-shell">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 md:px-7">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Code2 aria-hidden="true" className="size-4" />
            </div>
            <div>
              <h1 className="text-base font-semibold">Site Cloner</h1>
              <p className="text-xs text-muted-foreground">Fidelity-first exporter</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span className="size-2 rounded-full bg-success" />
            Server fetch · No AI
          </div>
        </div>
      </header>

      <section className="border-b border-border bg-background px-4 py-4 md:px-7">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 lg:flex-row">
          <div className="relative flex-1">
            <ExternalLink className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Website URL"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && startClone()}
              className="h-11 pl-10 font-mono"
            />
          </div>
          <Button onClick={startClone} disabled={busy} size="lg" className="h-11 min-w-32">
            {busy ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}Clone site
          </Button>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1600px] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 border-border lg:border-r">
          <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 md:px-6">
            <div className="flex items-center gap-3">
              <span
                className={`size-2 rounded-full ${stage === "error" ? "bg-destructive" : stage === "ready" ? "bg-success" : busy ? "animate-pulse bg-warning" : "bg-muted-foreground"}`}
              />
              <div>
                <p className="text-sm font-medium">{message}</p>
                {activeUrl && (
                  <p className="max-w-[50vw] truncate text-xs text-muted-foreground">{activeUrl}</p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label="Reload preview"
                disabled={!activeUrl}
                onClick={() => {
                  const current = activeUrl;
                  setActiveUrl("");
                  requestAnimationFrame(() => setActiveUrl(current));
                }}
              >
                <RefreshCw />
              </Button>
            </div>
          </div>

          <div className="preview-grid min-h-[680px] p-3 md:p-5">
            <div className="overflow-hidden rounded-lg border border-preview-border bg-preview shadow-preview">
              <div className="flex h-10 items-center gap-2 border-b border-preview-border bg-preview-bar px-3">
                <span className="size-2.5 rounded-full bg-window-red" />
                <span className="size-2.5 rounded-full bg-window-yellow" />
                <span className="size-2.5 rounded-full bg-window-green" />
                <span className="ml-3 flex-1 truncate rounded bg-preview-address px-3 py-1 text-center text-[11px] text-muted-foreground">
                  {activeUrl || "Preview will appear here"}
                </span>
              </div>
              {activeUrl ? (
                <iframe
                  key={activeUrl}
                  title="Cloned website preview"
                  src={activeUrl}
                  onLoad={() => {
                    setStage("ready");
                    setMessage("Preview ready — live source");
                  }}
                  className="h-[720px] w-full bg-preview"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                />
              ) : (
                <div className="flex h-[720px] flex-col items-center justify-center gap-4 text-center">
                  <div className="flex size-14 items-center justify-center rounded-lg border border-border bg-secondary">
                    <ScanSearch className="size-6 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="font-medium">Enter a public website URL</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      The live original site appears here.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="bg-panel p-5 lg:min-h-[820px]">
          <div className="space-y-7">
            <section>
              <p className="panel-label">Export target</p>
              <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg border border-border bg-background p-1">
                {(["static", "vite", "next"] as Target[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setTarget(item)}
                    className={`rounded-md px-2 py-2 text-xs font-medium transition-colors ${target === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}
                  >
                    {item === "static" ? "HTML" : item === "vite" ? "Vite" : "Next.js"}
                  </button>
                ))}
              </div>
              {target !== "static" && (
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground">Code language</p>
                  <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg border border-border bg-background p-1">
                    {(["auto", "jsx", "tsx"] as Lang[]).map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => setLang(item)}
                        className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${lang === item ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}
                      >
                        {item === "auto" ? "Auto" : item === "jsx" ? ".jsx" : ".tsx"}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    Auto: Vite → .jsx, Next.js → .tsx
                  </p>
                </div>
              )}
            </section>
            <section>
              <p className="panel-label">Pipeline</p>
              <ol className="mt-3 space-y-3">
                {[
                  "Opening live site",
                  "Streaming from origin",
                  "Displayed in browser",
                  "Ready to export",
                ].map((label, index) => {
                  const order =
                    stage === "idle"
                      ? -1
                      : stage === "fetching"
                        ? 0
                        : stage === "downloading"
                          ? 1
                          : stage === "rebuilding"
                            ? 2
                            : stage === "ready"
                              ? 3
                              : -1;
                  return (
                    <li key={label} className="flex items-center gap-3 text-xs">
                      <span
                        className={`flex size-5 items-center justify-center rounded-full border ${index <= order ? "border-success bg-success text-success-foreground" : "border-border text-muted-foreground"}`}
                      >
                        {index < order ? <Check className="size-3" /> : index + 1}
                      </span>
                      <span
                        className={index <= order ? "text-foreground" : "text-muted-foreground"}
                      >
                        {label}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
            <section className="border-t border-border pt-5">
              <Button
                onClick={download}
                disabled={!activeUrl || downloading}
                className="h-11 w-full"
              >
                {downloading ? <LoaderCircle className="animate-spin" /> : <Download />}Download{" "}
                {target === "static" ? "Static HTML" : target === "vite" ? "Vite React" : "Next.js"}{" "}
                ZIP
              </Button>
              <button
                type="button"
                className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-muted-foreground"
                aria-label="Show export details"
              >
                Fidelity runtime preserved <ChevronDown className="size-3" />
              </button>
            </section>
          </div>
        </aside>
      </div>
    </main>
  );
}
