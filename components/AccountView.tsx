import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, BadgeCheck } from "lucide-react";
import { identityPalette, seedFromString } from "@/lib/cover-art";
import type { ScraperEndpointView } from "@/lib/scraper-endpoints";
import { ScraperSettings } from "./ScraperSettings";
import { SignOutButton } from "./SignOutButton";
import { Wordmark } from "./Wordmark";
import { DeleteAccount } from "./DeleteAccount";
import { EXPORT_LIMIT } from "@/lib/usage-limits";

// Presentation only: the page resolves the session and the endpoint list and
// hands them in, so nothing here reads cookies or the database.

// Tertiary text at the app-wide 0.45 alpha measures ~4.1:1 here; 0.55 clears
// WCAG AA on every surface this page uses.
const AA_TEXT = { "--nh-text-3": "rgba(241, 241, 243, 0.55)" } as CSSProperties;

const FOCUS_RING = "outline-hidden focus-visible:ring-2 focus-visible:ring-nh-accent focus-visible:ring-offset-2 focus-visible:ring-offset-nh-bg";

export function AccountFrame({ children }: { children: ReactNode }) {
  return (
    <div style={AA_TEXT} className="min-h-dvh bg-nh-bg text-nh-text-1">
      <header
        className="sticky top-0 z-30 border-b border-nh-border"
        style={{ background: "var(--nh-bg-blur)", backdropFilter: "blur(14px) saturate(160%)" }}
      >
        {/* Full width, like the library header, so the logo does not move
            between the two screens. */}
        <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
          {/* prefetch={false}: the library route is the heavy bundle; leaving
              settings is a deliberate click, not something to pay for up front. */}
          <Link href="/" prefetch={false} aria-label="nhdb — back to the library" className={`rounded-md ${FOCUS_RING}`}>
            <Wordmark size={22} />
          </Link>
          <span aria-hidden className="font-mono text-[11px] text-nh-text-3">/</span>
          <h1 className="font-mono text-[11px] font-semibold tracking-wider text-nh-text-2 uppercase">account</h1>
          <span className="flex-1" />
          <Link
            href="/"
            prefetch={false}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-nh-border px-3 font-mono text-[11px] tracking-wide text-nh-text-2 hover:border-nh-border-strong hover:text-nh-text-1 pointer-coarse:h-10 ${FOCUS_RING}`}
          >
            <ArrowLeft className="size-3.5" /> library
          </Link>
        </div>
      </header>
      {/* Scroll margins keep a keyboard-focused control clear of the sticky
          header above and the sticky save bar below. */}
      <main className="mx-auto max-w-3xl px-4 pt-8 pb-16 [&_:is(a,button,input)]:scroll-mt-20 [&_:is(a,button,input)]:scroll-mb-24">
        {children}
      </main>
    </div>
  );
}

export function AccountView({
  email, name, endpoints, limit, secretStorageReady,
}: {
  email: string;
  name: string;
  endpoints: ScraperEndpointView[];
  limit: number;
  secretStorageReady: boolean;
}) {
  const [a, b] = identityPalette(seedFromString(email));
  const displayName = name || email.split("@")[0] || "you";
  // Array.from splits by code point, so a name starting with an emoji keeps it whole.
  const initial = Array.from(displayName)[0] ?? "?";

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="profile-name" className="overflow-hidden rounded-2xl border border-nh-border bg-nh-surface">
        <div aria-hidden className="relative h-24" style={{ background: `linear-gradient(115deg, ${a}, ${b})` }}>
          <div
            className="absolute inset-0 mix-blend-overlay"
            style={{
              backgroundImage: "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1.2px)",
              backgroundSize: "6px 6px",
            }}
          />
          <div className="absolute inset-0 bg-linear-to-b from-transparent to-nh-surface" />
        </div>
        <div className="relative -mt-10 flex items-end gap-4 px-5 pb-5">
          <div
            aria-hidden
            className="grid size-20 shrink-0 place-items-center rounded-2xl border-4 border-nh-surface font-display text-[32px] font-bold text-white uppercase shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
            style={{ background: `linear-gradient(135deg, ${a}, ${b})`, textShadow: "0 1px 10px rgba(0,0,0,0.35)" }}
          >
            {initial}
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <h2 id="profile-name" className="truncate font-display text-2xl font-bold tracking-[-0.02em]">
              {displayName}
            </h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate font-mono text-xs text-nh-text-2">{email}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(90,200,120,0.12)] px-2 py-0.5 font-mono text-[9.5px] tracking-wider text-[#5ac878] uppercase">
                <BadgeCheck className="size-3" strokeWidth={2.2} /> verified
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-nh-border px-5 py-3">
          <span className="font-mono text-[10px] tracking-wider text-nh-text-3 uppercase">signed in on this device</span>
          <SignOutButton />
        </div>
      </section>

      <ScraperSettings initialEndpoints={endpoints} limit={limit} secretStorageReady={secretStorageReady} />
      <section aria-labelledby="export-heading" className="flex flex-col gap-3 rounded-2xl border border-nh-border bg-nh-surface p-5">
        <h2 id="export-heading" className="font-display text-lg font-bold">Export my collection</h2>
        <p className="text-sm text-nh-text-2">Download your titles, names, metadata and reading history as JSON. Scraper credentials are excluded. Up to {EXPORT_LIMIT} exports per UTC day.</p>
        <a href="/api/export" className={`text-sm text-nh-accent underline ${FOCUS_RING}`}>Download collection JSON</a>
      </section>
      <DeleteAccount />
    </div>
  );
}

export function AccountSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-10">
      <span className="sr-only">Loading account…</span>
      <div className="h-52 rounded-2xl border border-nh-border bg-nh-surface motion-safe:animate-pulse" />
      <div className="flex flex-col gap-3">
        <div className="h-6 w-40 rounded bg-nh-pill motion-safe:animate-pulse" />
        <div className="h-4 w-full max-w-md rounded bg-nh-pill motion-safe:animate-pulse" />
        <div className="mt-2 h-56 rounded-xl border border-nh-border bg-nh-surface motion-safe:animate-pulse" />
      </div>
    </div>
  );
}
