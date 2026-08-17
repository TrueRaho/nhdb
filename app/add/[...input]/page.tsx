import { Suspense } from "react";
import type { Metadata } from "next";
import { extractHashtag } from "@/lib/utils";
import { QuickAdd } from "@/components/QuickAdd";

// The share-sheet target: one title, one screen, opened straight from a phone.
// Nothing in the app links here — the route is reachable only by its URL, which
// is the point. It is a separate segment so Next's per-route code splitting
// keeps the gallery, the dataset, the filter sheet and the scrape-job pool off
// this page entirely; the only work on open is the single scrape it was asked for.
export const metadata: Metadata = {
  title: "quick add · nhdb",
  // Not indexable even if the deployment's protection is ever lifted.
  robots: { index: false, follow: false },
};

export default function QuickAddPage({ params }: { params: Promise<{ input: string[] }> }) {
  // params is dynamic, so under cacheComponents it must resolve inside a
  // Suspense boundary — which is what makes the shell prerendered and instant.
  return (
    <Suspense fallback={<Shell note="opening…" />}>
      <Resolved params={params} />
    </Suspense>
  );
}

async function Resolved({ params }: { params: Promise<{ input: string[] }> }) {
  const { input } = await params;
  // Catch-all on purpose. A share-sheet shortcut may hand over the nhentai URL
  // percent-encoded ("/add/https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F", one
  // segment) or raw ("/add/https:/nhentai.net/g/177013/", several) depending on
  // whether its URL-encode step escapes slashes. Rejoining the segments makes
  // both spellings — and a plain "/add/177013" — land on the same title, so the
  // shortcut cannot be built wrong.
  const raw = input.map(safeDecode).join("/");
  const hashtag = extractHashtag(raw);
  if (!hashtag) return <Shell note={`not a title id: ${raw}`} error />;
  return <QuickAdd hashtag={hashtag} />;
}

// decodeURIComponent throws on a malformed escape ("%"), which would turn a
// typo in the address bar into a 500.
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function Shell({ note, error }: { note: string; error?: boolean }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-3 p-4">
      <header className="flex items-baseline gap-2">
        <span className="font-display text-[17px] font-bold tracking-tight text-nh-text-1">quick add</span>
      </header>
      <div className="flex gap-3">
        <div className="w-28 shrink-0">
          <div className="aspect-[350/500] w-full animate-pulse rounded-[var(--nh-radius-card)] bg-nh-pill" />
        </div>
        <div
          className="font-mono text-[11px]"
          style={{ color: error ? "#ff6b6b" : "var(--nh-text-2)" }}
        >
          {note}
        </div>
      </div>
    </div>
  );
}
