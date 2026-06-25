-- Drop two columns the app never reads:
--   title_link      — always equal to https://nhentai.net/g/<hashtag>/, rebuilt
--                     from the hashtag wherever a link is needed.
--   cover_blur_hash — reserved for a stored blur placeholder that was never
--                     shipped; covers use an on-the-fly gradient placeholder.
ALTER TABLE "titles" DROP COLUMN "title_link";
ALTER TABLE "titles" DROP COLUMN "cover_blur_hash";
