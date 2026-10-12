import { Prisma } from "./generated/prisma/client";
import type { ScrapeResult } from "./scrape-payload";

// The statement that files a scraped title (lib/titles.ts upsertScrapedTitle).
// It lives on its own so prisma/migration.test.ts can run the statement the app
// runs against a real database: this module opens no connection.
//
// Keyed by where the title comes from (migration 9). An nhentai title's
// hashtag is its gallery id; any other site's title keeps the key it was given
// on first save, or draws a new one from the sequence — COALESCE
// short-circuits, so a re-scrape burns no key. Being a single
// INSERT … ON CONFLICT, two saves of one new title cannot both allocate a row.
//
// A re-scrape refreshes what the page shows and keeps what it no longer shows.
// The reader stores 0 pages, no date and no cover when a page does not show
// them (nothing is invented), and the page read now may show less than the one
// read before: Hitomi's gallery page has no page count, which the old adapter
// read from the gallery's script. So, as with total_works on entities, a 0, a
// null and an "" mean "this reading did not say" and never clobber a value an
// earlier reading found. A first save stores what it has.
//
// alterName is user-managed (set manually via updateAlterName) — the scrape
// path never writes it, neither on create nor on re-scrape.
export function titleUpsertSql(userId: string, s: ScrapeResult): Prisma.Sql {
  const key = s.source === "nhentai"
    ? Prisma.sql`${Number(s.source_id)}`
    : Prisma.sql`COALESCE(
        (SELECT hashtag FROM titles WHERE user_id = ${userId} AND source = ${s.source} AND source_id = ${s.source_id}),
        nextval('titles_foreign_hashtag_seq'))`;
  return Prisma.sql`
    INSERT INTO titles (user_id, hashtag, source, source_id, url, title_name, image_link, pages, uploaded_at)
    VALUES (${userId}, ${key}, ${s.source}, ${s.source_id}, ${s.url}, ${s.title_name}, ${s.image_link}, ${s.pages},
            ${s.uploaded_at}::date)
    ON CONFLICT (user_id, source, source_id) DO UPDATE SET
      url = EXCLUDED.url,
      title_name = EXCLUDED.title_name,
      image_link = COALESCE(NULLIF(EXCLUDED.image_link, ''), titles.image_link),
      pages = COALESCE(NULLIF(EXCLUDED.pages, 0), titles.pages),
      uploaded_at = COALESCE(EXCLUDED.uploaded_at, titles.uploaded_at)
    RETURNING hashtag
  `;
}
