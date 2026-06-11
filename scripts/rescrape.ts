// Bulk re-scrape of titles through the running app's /api/scrape, so DB writes
// and Next cache invalidation happen in one place. The app must be running
// (pnpm dev / pnpm start), with Playwright locally or SCRAPER_SERVICE_URL set.
//
// Usage:
//   pnpm rescrape               # only titles with zero tags (likely broken scrapes)
//   pnpm rescrape --all         # every title (refreshes counts, pages, links)
//   pnpm rescrape --list        # print targets without scraping
//   pnpm rescrape --limit=20    # cap the number of titles processed
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: [".env.local", ".env"], quiet: true });

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const DELAY_MS = 2500;

const args = process.argv.slice(2);
const all = args.includes("--all");
const listOnly = args.includes("--list");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (all
    ? await sql`SELECT hashtag, title_name FROM titles ORDER BY hashtag`
    : await sql`
        SELECT hashtag, title_name FROM titles t
        WHERE NOT EXISTS (SELECT 1 FROM titlestotags tt WHERE tt.hashtag = t.hashtag)
        ORDER BY hashtag
      `) as { hashtag: number; title_name: string }[];

  const targets = rows.slice(0, limit);
  console.log(`${rows.length} titles ${all ? "total" : "without tags"}, processing ${targets.length}`);
  if (listOnly) {
    for (const r of targets) console.log(`#${r.hashtag}  ${r.title_name}`);
    return;
  }

  let ok = 0, fail = 0;
  for (const [i, r] of targets.entries()) {
    try {
      const res = await fetch(`${APP_URL}/api/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: String(r.hashtag), persist: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`HTTP ${res.status} ${err.error ?? ""}`.trim());
      }
      ok++;
      console.log(`✓ [${i + 1}/${targets.length}] #${r.hashtag}  ${r.title_name}`);
    } catch (e) {
      fail++;
      console.error(`✗ [${i + 1}/${targets.length}] #${r.hashtag}: ${e instanceof Error ? e.message : e}`);
    }
    if (i < targets.length - 1) await new Promise((s) => setTimeout(s, DELAY_MS));
  }
  console.log(`done: ${ok} updated, ${fail} failed`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
