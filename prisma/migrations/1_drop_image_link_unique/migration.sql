-- The hashtag is the primary key; uniqueness on image_link served no purpose and
-- was actively harmful: the scraper stores "" when a cover can't be parsed, so a
-- second cover-less title (or a reupload sharing a cover URL) violated the
-- constraint and made the upsert throw. Drop it.
--
-- image_link's uniqueness is backed by a UNIQUE *constraint* (not a bare index),
-- so it must be dropped via ALTER TABLE … DROP CONSTRAINT — `DROP INDEX` fails
-- with 2BP01 ("constraint … requires it").
ALTER TABLE "titles" DROP CONSTRAINT IF EXISTS "titles_image_link_key";
