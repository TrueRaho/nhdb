import type { CSSProperties, ReactNode } from "react";
import { CoverMosaic } from "@/components/CoverMosaic";
import { Wordmark } from "@/components/Wordmark";

const FEATURES = ["private library", "reading stats", "tag inference", "your own scraper"];

// These screens lean on the tertiary text colour for every label. The app-wide
// 0.45 alpha measures ~4.1:1 against these backgrounds; 0.55 clears WCAG AA
// (4.5:1) on bg, surface and input alike, so it is raised here.
const AA_TEXT = { "--nh-text-3": "rgba(241, 241, 243, 0.55)" } as CSSProperties;

/**
 * Frame for the sign-in, sign-up and verify screens: a brand panel on wide
 * screens, a compact masthead on phones, the form centred in what is left.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main style={AA_TEXT} className="min-h-dvh bg-nh-bg text-nh-text-1 lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      {/* Sticky and viewport-tall, so a long form on a short laptop screen
          scrolls past the panel instead of pushing its text below the fold. */}
      <aside className="relative hidden overflow-hidden border-r border-nh-border bg-nh-surface lg:sticky lg:top-0 lg:block lg:h-dvh">
        <CoverMosaic
          columns={12} perColumn={6} columnClassName="w-36 flex-none"
          className="absolute -top-[18%] -left-[8%] rotate-[-8deg] opacity-55"
        />
        <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_80%_0%,transparent_0%,var(--nh-surface)_75%)]" />
        <div className="absolute inset-x-0 bottom-0 h-3/4 bg-linear-to-t from-nh-surface via-nh-surface/90 to-transparent" />
        <div className="relative flex h-full flex-col justify-end gap-6 p-12 xl:p-16">
          <Wordmark size={72} />
          <p className="max-w-md font-display text-[22px] leading-snug font-medium tracking-tight text-pretty text-nh-text-2">
            Your collection, catalogued — tags, artists, reading history, and the titles you forgot you had.
          </p>
          <ul className="flex flex-wrap gap-2">
            {FEATURES.map((f) => (
              <li
                key={f}
                className="rounded-full border border-nh-border bg-nh-bg/60 px-3 py-1 font-mono text-[10px] tracking-wider text-nh-text-3 uppercase backdrop-blur"
              >
                {f}
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <div className="relative flex min-h-dvh flex-col overflow-hidden">
        <div className="relative h-36 shrink-0 overflow-hidden lg:hidden [@media(max-height:720px)]:h-24">
          <CoverMosaic
            columns={10} perColumn={2} columnClassName="w-24 flex-none"
            className="absolute -top-10 -left-6 rotate-[-6deg] opacity-45"
          />
          <div className="absolute inset-0 bg-linear-to-b from-nh-bg/10 via-nh-bg/60 to-nh-bg" />
          <div className="absolute inset-x-0 bottom-3 px-5 sm:px-8">
            <div className="mx-auto max-w-sm">
              <Wordmark size={34} />
            </div>
          </div>
        </div>
        <div className="flex flex-1 items-start justify-center px-5 pt-6 pb-10 sm:items-center sm:px-8 lg:py-12">
          {/* A fixed minimum height keeps the mode tabs from jumping when the
              sign-up form's extra field changes how tall the block is. */}
          <div className="w-full max-w-sm sm:min-h-[31rem] lg:min-h-[35rem]">{children}</div>
        </div>
        <p className="px-5 pb-6 text-center font-mono text-[10px] tracking-wide text-nh-text-3">
          each account sees only its own library
        </p>
      </div>
    </main>
  );
}
