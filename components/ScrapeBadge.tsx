"use client";

import { useScrapeJobs } from "./ScrapeJobsProvider";

// Floating badge for the "add" button: shows background scrape progress (amber,
// pulsing) or, once nothing is in flight, how many results wait to be reviewed
// (accent). Renders nothing when idle. Drop it next to a `position: relative`
// trigger.
export function ScrapeBadge() {
  const { scrapingCount, readyCount } = useScrapeJobs();
  if (scrapingCount === 0 && readyCount === 0) return null;

  const scraping = scrapingCount > 0;
  const count = scraping ? scrapingCount : readyCount;

  return (
    <span
      className="absolute -top-1 -right-1 min-w-3.75 h-3.75 px-1 grid place-items-center rounded-full font-mono text-[9px] font-bold leading-none pointer-events-none"
      style={{
        background: scraping ? "#e0a23a" : "var(--nh-accent)",
        color: "#0a0a0a",
        animation: scraping ? "nhPing 1.4s ease-out infinite" : "nhPopIn 160ms ease",
      }}
      title={scraping ? `${scrapingCount} scraping in background` : `${readyCount} ready to review`}
    >
      {count}
    </span>
  );
}
