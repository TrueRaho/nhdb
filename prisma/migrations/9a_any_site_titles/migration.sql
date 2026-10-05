-- Titles from any gallery site, not only the seven migration 9 named.
--
-- Migration 9 made a title's identity (source, source_id) with a closed list of
-- seven short source keys. Titles can now come from any site: `source` is the
-- site's host name ("hentaifox.com"), `source_id` the gallery id found in its
-- address (lib/sources.ts galleryIdOf), and the page address itself is stored,
-- because there is no per-site rule left to rebuild it from.
--
-- EXPAND ONLY. Nothing here rewrites a row or narrows what the previous app
-- version writes, so this is safe to apply while that version still serves
-- traffic (a preview build may apply it before the merge does):
--   * the seven legacy keys stay as they are — lib/sources.ts maps those sites'
--     hosts back to them, so a new scrape of one lands on the same row;
--   * nhentai keeps its rule from migration 9 (hashtag = gallery id, < 1e9),
--     so every existing row, link and bookmark keeps working;
--   * `url` is nullable: the previous version does not write it, and a legacy
--     row without one is still readable (lib/sources.ts legacyUrl).
--
-- Naming: "9a_" sorts after "9_" ('_' < 'a') and before nothing else, which is
-- what prisma's lexicographic replay needs; see CLAUDE.md "Naming trap".

BEGIN;

ALTER TABLE "titles" DROP CONSTRAINT "titles_source_format_check";
ALTER TABLE "titles" ALTER COLUMN "source" TYPE VARCHAR(253);
ALTER TABLE "titles" ALTER COLUMN "source_id" TYPE VARCHAR(255);
-- Cover addresses from arbitrary CDNs carry long paths and signed queries.
ALTER TABLE "titles" ALTER COLUMN "image_link" TYPE VARCHAR(1024);
ALTER TABLE "titles" ADD COLUMN "url" VARCHAR(1024);

-- A host name or a legacy key, and an id without whitespace. The application's
-- write boundary (lib/scrape-payload.ts) is the precise check; this is the
-- backstop against a writer that bypasses it.
ALTER TABLE "titles" ADD CONSTRAINT "titles_source_format_check"
  CHECK (
    "source" ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'
    AND length("source_id") BETWEEN 1 AND 255
    AND "source_id" !~ '\s'
  );
ALTER TABLE "titles" ADD CONSTRAINT "titles_url_check"
  CHECK ("url" IS NULL OR "url" ~ '^https?://');

-- The pages the seven legacy keys' titles live at — the same addresses
-- lib/sources.ts LEGACY rebuilds.
UPDATE "titles" SET "url" = CASE "source"
  WHEN 'nhentai'     THEN 'https://nhentai.net/g/' || "source_id" || '/'
  WHEN 'ehentai'     THEN 'https://e-hentai.org/g/' || "source_id" || '/'
  WHEN 'hitomi'      THEN 'https://hitomi.la/galleries/' || "source_id" || '.html'
  WHEN 'hentaifox'   THEN 'https://hentaifox.com/gallery/' || "source_id" || '/'
  WHEN 'imhentai'    THEN 'https://imhentai.xxx/gallery/' || "source_id" || '/'
  WHEN 'pururin'     THEN 'https://pururin.me/gallery/' || "source_id" || '/x'
  WHEN 'hentai2read' THEN 'https://hentai2read.com/' || "source_id" || '/'
END
WHERE "url" IS NULL;

-- Entity links are no longer identities. Entities are shared across sites by
-- name, a stored link is whichever site wrote it last, and two spellings of one
-- name can arrive with the same link ("quill ruva" / "quill-ruva" both slug to
-- nhentai.net/artist/quill-ruva/) — under these indexes that second write failed
-- the whole title's save. Names stay unique per user; links are just links.
DROP INDEX IF EXISTS "artists_user_id_artist_link_key";
DROP INDEX IF EXISTS "groups_user_id_group_link_key";
DROP INDEX IF EXISTS "characters_user_id_character_link_key";
DROP INDEX IF EXISTS "parodies_user_id_parodie_link_key";
DROP INDEX IF EXISTS "tags_user_id_tag_link_key";

COMMIT;
