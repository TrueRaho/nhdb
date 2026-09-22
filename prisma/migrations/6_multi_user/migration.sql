-- Multi-user: every row in the collection gains an owner.
--
-- Shape chosen (see CLAUDE.md "Tenancy"): FULL per-user isolation. titles are
-- keyed (user_id, hashtag) because the hashtag is an nhentai gallery id and two
-- people legitimately own the same one; the five entity tables get their own
-- per-user rows so that tags.title_count, titles.avg_tag_value, tag affinity and
-- ghost tags keep meaning "within MY collection" — every one of those numbers is
-- a fraction of the collection, and a shared vocabulary would silently compute
-- them across strangers' libraries.
--
-- Two properties fall out of that choice and are worth stating, because they are
-- the reason the rest of the database needs almost no other change:
--
--   * Entity ids stay globally unique surrogates, so every id_tag / id_artist /…
--     already belongs to exactly one user. The migration-3 count triggers
--     (COUNT(*) … WHERE id_tag = t.id_tag) therefore stay correct as written,
--     and the migration-4 orphan-cleanup triggers (which key on OLD.id_*) are
--     left completely untouched. Do not "fix" them — they are already per-user.
--   * Two users writing at once touch disjoint tags rows, so the serialized-write
--     contract the count triggers impose stays a PER-USER contract, exactly as
--     wide as it was when there was one user. Concurrency was not made worse.
--
-- What the join tables gain is a *composite* FK to both parents — the title AND
-- the entity, each including user_id. That is what makes a cross-tenant link
-- unrepresentable in the database rather than merely unwritten by the app.
--
-- Existing rows are assigned to a sentinel owner and handed over by
-- `pnpm claim <neon-auth-user-id>` (scripts/claim.ts), because the owner's id
-- does not exist until they sign up and so cannot be written here.

-- Prisma does not automatically wrap a PostgreSQL migration in a transaction.
-- Re-keying all twelve tables must either complete together or leave the old
-- schema intact, including when any constraint/index recreation fails.
BEGIN;

-- 1. Tenant columns -----------------------------------------------------------
-- NOT NULL DEFAULT backfills every existing row in one pass; the DEFAULT is then
-- dropped so a future INSERT that forgets user_id fails loudly instead of
-- quietly filing the row under the sentinel.

ALTER TABLE "titles"             ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "artists"            ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "groups"             ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "characters"         ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "parodies"           ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "tags"               ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "titlestoartists"    ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "titlestogroups"     ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "titlestocharacters" ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "titlestoparodies"   ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "titlestotags"       ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';
ALTER TABLE "read_logs"          ADD COLUMN "user_id" VARCHAR(64) NOT NULL DEFAULT 'nhdb:unclaimed';

ALTER TABLE "titles"             ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "artists"            ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "groups"             ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "characters"         ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "parodies"           ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "tags"               ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "titlestoartists"    ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "titlestogroups"     ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "titlestocharacters" ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "titlestoparodies"   ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "titlestotags"       ALTER COLUMN "user_id" DROP DEFAULT;
ALTER TABLE "read_logs"          ALTER COLUMN "user_id" DROP DEFAULT;

-- 2. Drop the single-column foreign keys --------------------------------------
-- They all have to go before titles' primary key can be replaced, and the
-- entity-side ones are replaced by composite versions in step 5.

ALTER TABLE "titlestoartists"    DROP CONSTRAINT "titlestoartists_hashtag_fkey";
ALTER TABLE "titlestogroups"     DROP CONSTRAINT "titlestogroups_hashtag_fkey";
ALTER TABLE "titlestocharacters" DROP CONSTRAINT "titlestocharacters_hashtag_fkey";
ALTER TABLE "titlestoparodies"   DROP CONSTRAINT "titlestoparodies_hashtag_fkey";
ALTER TABLE "titlestotags"       DROP CONSTRAINT "titlestotags_hashtag_fkey";
ALTER TABLE "read_logs"          DROP CONSTRAINT "read_logs_hashtag_fkey";

ALTER TABLE "titlestoartists"    DROP CONSTRAINT "titlestoartists_id_artist_fkey";
ALTER TABLE "titlestogroups"     DROP CONSTRAINT "titlestogroups_id_group_fkey";
ALTER TABLE "titlestocharacters" DROP CONSTRAINT "titlestocharacters_id_character_fkey";
ALTER TABLE "titlestoparodies"   DROP CONSTRAINT "titlestoparodies_id_parodie_fkey";
ALTER TABLE "titlestotags"       DROP CONSTRAINT "titlestotags_id_tag_fkey";

-- 3. Re-key titles ------------------------------------------------------------

ALTER TABLE "titles" DROP CONSTRAINT "titles_pkey";
ALTER TABLE "titles" ADD CONSTRAINT "titles_pkey" PRIMARY KEY ("user_id", "hashtag");

-- Migration 1 removed this as a table constraint, but 0_init also exists in a
-- form that created a bare unique index. Remove either representation: two
-- users can own the same gallery/cover, and missing covers share an empty URL.
ALTER TABLE "titles" DROP CONSTRAINT IF EXISTS "titles_image_link_key";
DROP INDEX IF EXISTS "titles_image_link_key";

-- 4. Entity tables: per-user uniqueness, plus a composite FK target -----------
-- Each old global unique is dropped as a CONSTRAINT first and as an INDEX second:
-- the two init migrations in this repo's history spell them differently (a table
-- constraint vs. a bare CREATE UNIQUE INDEX), and a database built from either
-- one has to end up in the same place. IF EXISTS makes the unused half a no-op.
--
-- The (user_id, id_*) unique is redundant as a uniqueness claim — id_* is
-- already the primary key — but a composite foreign key needs a unique index on
-- exactly the columns it references, and that pair is what lets a join row
-- prove its entity belongs to the same user as its title.

ALTER TABLE "artists" DROP CONSTRAINT IF EXISTS "artists_artist_name_key";
DROP INDEX IF EXISTS "artists_artist_name_key";
ALTER TABLE "artists" DROP CONSTRAINT IF EXISTS "artists_artist_link_key";
DROP INDEX IF EXISTS "artists_artist_link_key";
CREATE UNIQUE INDEX "artists_user_id_artist_name_key" ON "artists" ("user_id", "artist_name");
CREATE UNIQUE INDEX "artists_user_id_artist_link_key" ON "artists" ("user_id", "artist_link");
ALTER TABLE "artists" ADD CONSTRAINT "artists_user_id_id_artist_key" UNIQUE ("user_id", "id_artist");

ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_group_name_key";
DROP INDEX IF EXISTS "groups_group_name_key";
ALTER TABLE "groups" DROP CONSTRAINT IF EXISTS "groups_group_link_key";
DROP INDEX IF EXISTS "groups_group_link_key";
CREATE UNIQUE INDEX "groups_user_id_group_name_key" ON "groups" ("user_id", "group_name");
CREATE UNIQUE INDEX "groups_user_id_group_link_key" ON "groups" ("user_id", "group_link");
ALTER TABLE "groups" ADD CONSTRAINT "groups_user_id_id_group_key" UNIQUE ("user_id", "id_group");

ALTER TABLE "characters" DROP CONSTRAINT IF EXISTS "characters_character_name_key";
DROP INDEX IF EXISTS "characters_character_name_key";
ALTER TABLE "characters" DROP CONSTRAINT IF EXISTS "characters_character_link_key";
DROP INDEX IF EXISTS "characters_character_link_key";
CREATE UNIQUE INDEX "characters_user_id_character_name_key" ON "characters" ("user_id", "character_name");
CREATE UNIQUE INDEX "characters_user_id_character_link_key" ON "characters" ("user_id", "character_link");
ALTER TABLE "characters" ADD CONSTRAINT "characters_user_id_id_character_key" UNIQUE ("user_id", "id_character");

ALTER TABLE "parodies" DROP CONSTRAINT IF EXISTS "parodies_parodie_name_key";
DROP INDEX IF EXISTS "parodies_parodie_name_key";
ALTER TABLE "parodies" DROP CONSTRAINT IF EXISTS "parodies_parodie_link_key";
DROP INDEX IF EXISTS "parodies_parodie_link_key";
CREATE UNIQUE INDEX "parodies_user_id_parodie_name_key" ON "parodies" ("user_id", "parodie_name");
CREATE UNIQUE INDEX "parodies_user_id_parodie_link_key" ON "parodies" ("user_id", "parodie_link");
ALTER TABLE "parodies" ADD CONSTRAINT "parodies_user_id_id_parodie_key" UNIQUE ("user_id", "id_parodie");

ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_tag_name_key";
DROP INDEX IF EXISTS "tags_tag_name_key";
ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_tag_link_key";
DROP INDEX IF EXISTS "tags_tag_link_key";
CREATE UNIQUE INDEX "tags_user_id_tag_name_key" ON "tags" ("user_id", "tag_name");
CREATE UNIQUE INDEX "tags_user_id_tag_link_key" ON "tags" ("user_id", "tag_link");
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_id_tag_key" UNIQUE ("user_id", "id_tag");

-- 5. Join tables: re-key, and make cross-tenant links unrepresentable ---------
-- Every join row now names its owner once and proves it twice — against the
-- title and against the entity. A row pointing at user A's title and user B's
-- tag cannot be inserted at all, whatever the application code does.
--
-- The foreign keys are DEFERRABLE INITIALLY IMMEDIATE: they behave exactly like
-- ordinary keys (checked per statement) and exist in that form for one reason —
-- `pnpm claim` rewrites user_id on parents and children together, which no
-- statement ordering can make valid, so it opens with SET CONSTRAINTS ALL
-- DEFERRED. Nothing else in the app relies on deferral.

ALTER TABLE "titlestoartists" DROP CONSTRAINT "titlestoartists_pkey";
ALTER TABLE "titlestoartists" ADD CONSTRAINT "titlestoartists_pkey" PRIMARY KEY ("user_id", "hashtag", "id_artist");
ALTER TABLE "titlestoartists" ADD CONSTRAINT "titlestoartists_title_fkey"
  FOREIGN KEY ("user_id", "hashtag") REFERENCES "titles" ("user_id", "hashtag")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "titlestoartists" ADD CONSTRAINT "titlestoartists_artist_fkey"
  FOREIGN KEY ("user_id", "id_artist") REFERENCES "artists" ("user_id", "id_artist")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "titlestogroups" DROP CONSTRAINT "titlestogroups_pkey";
ALTER TABLE "titlestogroups" ADD CONSTRAINT "titlestogroups_pkey" PRIMARY KEY ("user_id", "hashtag", "id_group");
ALTER TABLE "titlestogroups" ADD CONSTRAINT "titlestogroups_title_fkey"
  FOREIGN KEY ("user_id", "hashtag") REFERENCES "titles" ("user_id", "hashtag")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "titlestogroups" ADD CONSTRAINT "titlestogroups_group_fkey"
  FOREIGN KEY ("user_id", "id_group") REFERENCES "groups" ("user_id", "id_group")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "titlestocharacters" DROP CONSTRAINT "titlestocharacters_pkey";
ALTER TABLE "titlestocharacters" ADD CONSTRAINT "titlestocharacters_pkey" PRIMARY KEY ("user_id", "hashtag", "id_character");
ALTER TABLE "titlestocharacters" ADD CONSTRAINT "titlestocharacters_title_fkey"
  FOREIGN KEY ("user_id", "hashtag") REFERENCES "titles" ("user_id", "hashtag")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "titlestocharacters" ADD CONSTRAINT "titlestocharacters_character_fkey"
  FOREIGN KEY ("user_id", "id_character") REFERENCES "characters" ("user_id", "id_character")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "titlestoparodies" DROP CONSTRAINT "titlestoparodies_pkey";
ALTER TABLE "titlestoparodies" ADD CONSTRAINT "titlestoparodies_pkey" PRIMARY KEY ("user_id", "hashtag", "id_parodie");
ALTER TABLE "titlestoparodies" ADD CONSTRAINT "titlestoparodies_title_fkey"
  FOREIGN KEY ("user_id", "hashtag") REFERENCES "titles" ("user_id", "hashtag")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "titlestoparodies" ADD CONSTRAINT "titlestoparodies_parody_fkey"
  FOREIGN KEY ("user_id", "id_parodie") REFERENCES "parodies" ("user_id", "id_parodie")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "titlestotags" DROP CONSTRAINT "titlestotags_pkey";
ALTER TABLE "titlestotags" ADD CONSTRAINT "titlestotags_pkey" PRIMARY KEY ("user_id", "hashtag", "id_tag");
ALTER TABLE "titlestotags" ADD CONSTRAINT "titlestotags_title_fkey"
  FOREIGN KEY ("user_id", "hashtag") REFERENCES "titles" ("user_id", "hashtag")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "titlestotags" ADD CONSTRAINT "titlestotags_tag_fkey"
  FOREIGN KEY ("user_id", "id_tag") REFERENCES "tags" ("user_id", "id_tag")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

-- read_logs keeps its own surrogate id; only the parent reference changes.
ALTER TABLE "read_logs" ADD CONSTRAINT "read_logs_title_fkey"
  FOREIGN KEY ("user_id", "hashtag") REFERENCES "titles" ("user_id", "hashtag")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

-- 6. Indexes: every query is now "within one collection" ----------------------
-- Each sort index gains user_id as its leading column, because every ORDER BY in
-- the app runs under a WHERE user_id = … — a bare (created_at DESC) index can no
-- longer serve the first page without a filter step over other people's rows.

DROP INDEX IF EXISTS "titles_created_at_idx";
DROP INDEX IF EXISTS "titles_last_read_at_idx";
DROP INDEX IF EXISTS "titles_read_count_idx";
DROP INDEX IF EXISTS "titles_uploaded_at_idx";
DROP INDEX IF EXISTS "titles_pages_idx";
DROP INDEX IF EXISTS "titles_avg_tag_value_idx";
CREATE INDEX "titles_user_id_created_at_idx"    ON "titles" ("user_id", "created_at" DESC);
CREATE INDEX "titles_user_id_last_read_at_idx"  ON "titles" ("user_id", "last_read_at" DESC);
CREATE INDEX "titles_user_id_read_count_idx"    ON "titles" ("user_id", "read_count" DESC);
CREATE INDEX "titles_user_id_uploaded_at_idx"   ON "titles" ("user_id", "uploaded_at" DESC);
CREATE INDEX "titles_user_id_pages_idx"         ON "titles" ("user_id", "pages");
CREATE INDEX "titles_user_id_avg_tag_value_idx" ON "titles" ("user_id", "avg_tag_value");

DROP INDEX IF EXISTS "read_logs_read_at_idx";
DROP INDEX IF EXISTS "read_logs_hashtag_idx";
CREATE INDEX "read_logs_user_id_read_at_idx" ON "read_logs" ("user_id", "read_at" DESC);
CREATE INDEX "read_logs_user_id_hashtag_idx" ON "read_logs" ("user_id", "hashtag");

-- The join tables' (id_*) indexes are deliberately left alone: an entity id is
-- already unique to one user, so an index on it is already a per-user index.
-- They are what the migration-3 count triggers and the affinity/ghost scans use.

-- 7. Migration-3 triggers: teach the average about the composite key ----------
-- tags.title_count needs no change (see the header: id_tag is per-user, and the
-- new composite FK is what guarantees it). titles.avg_tag_value does: it matched
-- rows on `ti.hashtag = s.hashtag`, which now matches EVERY user's copy of that
-- hashtag and would cross-assign averages between collections.

CREATE OR REPLACE FUNCTION nhdb_ttt_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Each inserted tag now covers one more title. Unchanged: id_tag identifies
  -- one user's tag row, so COUNT(*) over its links is already that user's count.
  UPDATE "tags" t
  SET "title_count" = (SELECT COUNT(*) FROM "titlestotags" tt WHERE tt.id_tag = t.id_tag)
  WHERE t.id_tag IN (SELECT DISTINCT id_tag FROM new_rows);

  -- Every title holding any of those tags has a new average. Both the affected
  -- set and the final match are (user_id, hashtag) pairs now.
  UPDATE "titles" ti
  SET "avg_tag_value" = s.avg
  FROM (
    SELECT tt."user_id", tt.hashtag, AVG(t."title_count")::float8 AS avg
    FROM "titlestotags" tt JOIN "tags" t USING (id_tag)
    WHERE (tt."user_id", tt.hashtag) IN (
      SELECT DISTINCT x."user_id", x.hashtag FROM "titlestotags" x
      WHERE x.id_tag IN (SELECT DISTINCT id_tag FROM new_rows)
    )
    GROUP BY tt."user_id", tt.hashtag
  ) s
  WHERE ti."user_id" = s."user_id" AND ti.hashtag = s.hashtag;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION nhdb_ttt_after_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "tags" t
  SET "title_count" = (SELECT COUNT(*) FROM "titlestotags" tt WHERE tt.id_tag = t.id_tag)
  WHERE t.id_tag IN (SELECT DISTINCT id_tag FROM old_rows);

  -- Titles that still hold those tags, plus the titles that just lost one.
  UPDATE "titles" ti
  SET "avg_tag_value" = s.avg
  FROM (
    SELECT tt."user_id", tt.hashtag, AVG(t."title_count")::float8 AS avg
    FROM "titlestotags" tt JOIN "tags" t USING (id_tag)
    WHERE (tt."user_id", tt.hashtag) IN (
      SELECT DISTINCT x."user_id", x.hashtag FROM "titlestotags" x
      WHERE x.id_tag IN (SELECT DISTINCT id_tag FROM old_rows)
      UNION
      SELECT DISTINCT o."user_id", o.hashtag FROM old_rows o
    )
    GROUP BY tt."user_id", tt.hashtag
  ) s
  WHERE ti."user_id" = s."user_id" AND ti.hashtag = s.hashtag;

  -- A title that lost its last tag has no average anymore.
  UPDATE "titles" ti
  SET "avg_tag_value" = NULL
  WHERE (ti."user_id", ti.hashtag) IN (SELECT DISTINCT o."user_id", o.hashtag FROM old_rows o)
    AND NOT EXISTS (
      SELECT 1 FROM "titlestotags" tt
      WHERE tt."user_id" = ti."user_id" AND tt.hashtag = ti.hashtag
    );

  RETURN NULL;
END;
$$;

-- The triggers themselves (trg_ttt_after_insert / trg_ttt_after_delete) and the
-- five migration-4 orphan-cleanup constraint triggers are untouched: CREATE OR
-- REPLACE FUNCTION rebinds the bodies in place, and the orphan sweeps already
-- key on the per-user entity id.

COMMIT;
