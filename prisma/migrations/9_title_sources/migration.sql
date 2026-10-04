-- Titles from more than one site.
--
-- Until now every title was an nhentai gallery and `hashtag` was its gallery
-- id. Titles can now come from E-Hentai, Hitomi, HentaiFox, IMHentai, Pururin
-- and Hentai2Read as well (lib/sources.ts), whose ids are not nhentai's:
-- numbers that collide with nhentai's ("hentaifox 42" is not "#42"), a gid +
-- token pair (E-Hentai), a slug (Hentai2Read).
--
-- What a title IS stays one column: `hashtag` is still the per-user key that
-- every join table, the read log, the cache tags, the swipe deck and the URL
-- state hold, so none of them change. What it MEANS is split in two ranges:
--
--   * nhentai titles keep their gallery id as the hashtag, below 1e9 — every
--     existing row, link and bookmark keeps working exactly as before;
--   * other sites' titles get a surrogate from titles_foreign_hashtag_seq,
--     from 1e9 up to the INT4 ceiling (~1.15 billion keys).
--
-- Where a title comes from is the new pair (source, source_id), unique per
-- user — that is what the add flow deduplicates on and what the scraper is
-- asked for. The CHECK below ties the two halves together so the ranges cannot
-- drift: an nhentai row's hashtag IS its source id, and nothing else may sit
-- in nhentai's range.
--
-- The list of sites is deliberately NOT a database constraint: adding a site
-- is then an application change, not a migration (and this is the last
-- single-digit migration slot — see CLAUDE.md "Naming trap"). The app's write
-- boundary (lib/scrape-payload.ts) is what admits only known sites, canonical
-- ids and allow-listed links; the format CHECK here is the backstop.

BEGIN;

ALTER TABLE "titles" ADD COLUMN "source" VARCHAR(16) NOT NULL DEFAULT 'nhentai';
ALTER TABLE "titles" ADD COLUMN "source_id" VARCHAR(128);
UPDATE "titles" SET "source_id" = "hashtag"::text;
ALTER TABLE "titles" ALTER COLUMN "source_id" SET NOT NULL;
-- No default from here on: a writer that forgets the source fails loudly
-- instead of filing a foreign title as nhentai.
ALTER TABLE "titles" ALTER COLUMN "source" DROP DEFAULT;

ALTER TABLE "titles" ADD CONSTRAINT "titles_source_format_check"
  CHECK ("source" ~ '^[a-z0-9]{1,16}$' AND length("source_id") > 0);

ALTER TABLE "titles" ADD CONSTRAINT "titles_source_hashtag_check"
  CHECK (
    CASE WHEN "source" = 'nhentai'
      THEN "hashtag" > 0 AND "hashtag" < 1000000000 AND "source_id" = "hashtag"::text
      ELSE "hashtag" >= 1000000000
    END
  );

CREATE UNIQUE INDEX "titles_user_id_source_source_id_key" ON "titles" ("user_id", "source", "source_id");

-- Global rather than per user: simpler, and a key never repeats across
-- accounts, which keeps `pnpm claim` and any future merge trivially safe.
CREATE SEQUENCE "titles_foreign_hashtag_seq"
  AS INTEGER START WITH 1000000000 MINVALUE 1000000000 MAXVALUE 2147483647 NO CYCLE;

-- Not every site prints an upload date (HentaiFox, Hentai2Read…), and the
-- scraper never fabricates one — "unknown" has to be storable.
ALTER TABLE "titles" ALTER COLUMN "uploaded_at" DROP NOT NULL;

COMMIT;
