import { Suspense } from "react";
import { requireUserIdOrRedirect } from "@/lib/session";
import type { Metadata } from "next";
import { parseTitleRef, quickAddInput, quickAddPath, type PageQuery } from "@/lib/sources";
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

type Props = { params: Promise<{ input: string[] }>; searchParams: Promise<PageQuery> };

export default function QuickAddPage({ params, searchParams }: Props) {
  // params is dynamic, so under cacheComponents it must resolve inside a
  // Suspense boundary — which is what makes the shell prerendered and instant.
  return (
    <Suspense fallback={<Shell note="opening…" />}>
      <Resolved params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Resolved({ params, searchParams }: Props) {
  const [{ input }, query] = await Promise.all([params, searchParams]);
  await requireUserIdOrRedirect(quickAddPath(input, query));
  // Catch-all on purpose. A share-sheet shortcut may hand over the gallery URL
  // percent-encoded ("/add/https%3A%2F%2Fnhentai.net%2Fg%2F177013%2F", one
  // segment) or raw ("/add/https://site.example/view.php?id=7", several, its
  // query on this page) depending on whether its URL-encode step escapes
  // slashes. quickAddInput puts the link back together, so both spellings —
  // and a plain "/add/177013" — land on the same title and the shortcut cannot
  // be built wrong. Only a link that looks like one title's gets past this
  // line (lib/sources.ts).
  const raw = quickAddInput(input, query);
  const ref = parseTitleRef(raw);
  if (!ref) return <Shell note={`not a link to a title: ${raw}`} error />;
  return <QuickAdd titleRef={ref} />;
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
