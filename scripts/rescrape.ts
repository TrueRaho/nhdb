// Bulk re-scrape of titles through the running app's /api/scrape, so DB writes
// and Next cache invalidation happen in one place. The app must be running
// (pnpm dev / pnpm start), with Playwright locally or SCRAPER_SERVICE_URL set.
//
// Usage:
//   pnpm rescrape               # only titles with zero tags (likely broken scrapes)
//   pnpm rescrape --all         # every title (refreshes counts, pages, links)
//   pnpm rescrape --list        # print targets without scraping
//   pnpm rescrape --limit=20    # cap the number of titles processed
//
// Set NHDB_SESSION_COOKIE to your signed-in browser Cookie header.
// Set VERCEL_AUTOMATION_BYPASS_SECRET when APP_URL targets a Vercel deployment with Deployment Protection.
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: [".env.local", ".env"], quiet: true });

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
// Optional Vercel Deployment Protection bypass; when unset, no extra headers are sent.
const BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const bypassHeaders: Record<string, string> = BYPASS_SECRET
  ? { "x-vercel-protection-bypass": BYPASS_SECRET, "x-vercel-set-bypass-cookie": "true" }
  : {};
const DELAY_MS = 2500;
const REQUEST_TIMEOUT_MS = 60_000; // one hung route must not stall the whole loop

const args = process.argv.slice(2);
const all = args.includes("--all");
const listOnly = args.includes("--list");
const limitArg = args.find((a) => a.startsWith("--limit="));
// A malformed --limit= parses to NaN, and rows.slice(0, NaN) would silently
// process ZERO titles — treat it as "no limit" instead.
const parsedLimit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const limit = Number.isNaN(parsedLimit) ? Infinity : parsedLimit;

async function main() {
  const cookie = process.env.NHDB_SESSION_COOKIE?.trim();
  if (!cookie) throw new Error("Set NHDB_SESSION_COOKIE to a signed-in browser Cookie header");
  const sessionResponse = await fetch(`${APP_URL}/api/auth/get-session`, {
    headers: { ...bypassHeaders, Cookie: cookie },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!sessionResponse.ok) throw new Error(`Session lookup failed (HTTP ${sessionResponse.status})`);
  const session = await sessionResponse.json() as {
    session?: { userId?: string };
    user?: { id?: string; emailVerified?: boolean };
  } | null;
  const userId = session?.user?.id;
  if (!userId || session?.session?.userId !== userId || session.user?.emailVerified !== true) {
    throw new Error("A verified signed-in session is required");
  }
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (all
    ? await sql`SELECT hashtag, source, source_id, title_name FROM titles WHERE user_id = ${userId} ORDER BY hashtag`
    : await sql`
        SELECT hashtag, source, source_id, title_name FROM titles t
        WHERE t.user_id = ${userId}
          AND NOT EXISTS (SELECT 1 FROM titlestotags tt WHERE tt.user_id = t.user_id AND tt.hashtag = t.hashtag)
        ORDER BY hashtag
      `) as { hashtag: number; source: string; source_id: string; title_name: string }[];
  // `source:id` — what /api/scrape parses; the hashtag of a title from another
  // site is only the collection's key, not something its site knows.
  const ref = (r: (typeof rows)[number]) => `${r.source}:${r.source_id}`;

  const targets = rows.slice(0, limit);
  console.log(`${rows.length} titles ${all ? "total" : "without tags"}, processing ${targets.length}`);
  if (listOnly) {
    for (const r of targets) console.log(`${ref(r)}  ${r.title_name}`);
    return;
  }

  let ok = 0, fail = 0;
  for (const [i, r] of targets.entries()) {
    try {
      const res = await fetch(`${APP_URL}/api/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bypassHeaders, Cookie: cookie },
        redirect: "error",
        body: JSON.stringify({ input: ref(r), persist: true }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`HTTP ${res.status} ${err.error ?? ""}`.trim());
      }
      ok++;
      console.log(`✓ [${i + 1}/${targets.length}] ${ref(r)}  ${r.title_name}`);
    } catch (e) {
      fail++;
      console.error(`✗ [${i + 1}/${targets.length}] ${ref(r)}: ${e instanceof Error ? e.message : e}`);
    }
    if (i < targets.length - 1) await new Promise((s) => setTimeout(s, DELAY_MS));
  }
  console.log(`done: ${ok} updated, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => { console.error(e); process.exit(1); });
