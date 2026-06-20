-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "titles" (
    "hashtag" INTEGER NOT NULL,
    "title_name" VARCHAR(255) NOT NULL,
    "alter_name" VARCHAR(255),
    "title_link" VARCHAR(255) NOT NULL,
    "image_link" VARCHAR(255) NOT NULL,
    "pages" INTEGER NOT NULL,
    "uploaded_at" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_count" INTEGER NOT NULL DEFAULT 0,
    "last_read_at" TIMESTAMP(3),
    "cover_blur_hash" TEXT,

    CONSTRAINT "titles_pkey" PRIMARY KEY ("hashtag")
);

-- CreateTable
CREATE TABLE "artists" (
    "id_artist" SERIAL NOT NULL,
    "artist_name" VARCHAR(255) NOT NULL,
    "artist_link" VARCHAR(255) NOT NULL,
    "total_works" INTEGER,

    CONSTRAINT "artists_pkey" PRIMARY KEY ("id_artist")
);

-- CreateTable
CREATE TABLE "groups" (
    "id_group" SERIAL NOT NULL,
    "group_name" VARCHAR(255) NOT NULL,
    "group_link" VARCHAR(255) NOT NULL,
    "total_works" INTEGER,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id_group")
);

-- CreateTable
CREATE TABLE "characters" (
    "id_character" SERIAL NOT NULL,
    "character_name" VARCHAR(255) NOT NULL,
    "character_link" VARCHAR(255) NOT NULL,
    "total_works" INTEGER,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id_character")
);

-- CreateTable
CREATE TABLE "parodies" (
    "id_parodie" SERIAL NOT NULL,
    "parodie_name" VARCHAR(255) NOT NULL,
    "parodie_link" VARCHAR(255) NOT NULL,
    "total_works" INTEGER,

    CONSTRAINT "parodies_pkey" PRIMARY KEY ("id_parodie")
);

-- CreateTable
CREATE TABLE "tags" (
    "id_tag" SERIAL NOT NULL,
    "tag_name" VARCHAR(255) NOT NULL,
    "tag_link" VARCHAR(255) NOT NULL,
    "total_works" INTEGER,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id_tag")
);

-- CreateTable
CREATE TABLE "titlestoartists" (
    "hashtag" INTEGER NOT NULL,
    "id_artist" INTEGER NOT NULL,

    CONSTRAINT "titlestoartists_pkey" PRIMARY KEY ("hashtag","id_artist")
);

-- CreateTable
CREATE TABLE "titlestogroups" (
    "hashtag" INTEGER NOT NULL,
    "id_group" INTEGER NOT NULL,

    CONSTRAINT "titlestogroups_pkey" PRIMARY KEY ("hashtag","id_group")
);

-- CreateTable
CREATE TABLE "titlestocharacters" (
    "hashtag" INTEGER NOT NULL,
    "id_character" INTEGER NOT NULL,

    CONSTRAINT "titlestocharacters_pkey" PRIMARY KEY ("hashtag","id_character")
);

-- CreateTable
CREATE TABLE "titlestoparodies" (
    "hashtag" INTEGER NOT NULL,
    "id_parodie" INTEGER NOT NULL,

    CONSTRAINT "titlestoparodies_pkey" PRIMARY KEY ("hashtag","id_parodie")
);

-- CreateTable
CREATE TABLE "titlestotags" (
    "hashtag" INTEGER NOT NULL,
    "id_tag" INTEGER NOT NULL,

    CONSTRAINT "titlestotags_pkey" PRIMARY KEY ("hashtag","id_tag")
);

-- CreateTable
CREATE TABLE "read_logs" (
    "id" SERIAL NOT NULL,
    "hashtag" INTEGER NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "read_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "titles_image_link_key" ON "titles"("image_link");

-- CreateIndex
CREATE INDEX "titles_created_at_idx" ON "titles"("created_at" DESC);

-- CreateIndex
CREATE INDEX "titles_last_read_at_idx" ON "titles"("last_read_at" DESC);

-- CreateIndex
CREATE INDEX "titles_read_count_idx" ON "titles"("read_count" DESC);

-- CreateIndex
CREATE INDEX "titles_uploaded_at_idx" ON "titles"("uploaded_at" DESC);

-- CreateIndex
CREATE INDEX "titles_pages_idx" ON "titles"("pages");

-- CreateIndex
CREATE UNIQUE INDEX "artists_artist_name_key" ON "artists"("artist_name");

-- CreateIndex
CREATE UNIQUE INDEX "artists_artist_link_key" ON "artists"("artist_link");

-- CreateIndex
CREATE UNIQUE INDEX "groups_group_name_key" ON "groups"("group_name");

-- CreateIndex
CREATE UNIQUE INDEX "groups_group_link_key" ON "groups"("group_link");

-- CreateIndex
CREATE UNIQUE INDEX "characters_character_name_key" ON "characters"("character_name");

-- CreateIndex
CREATE UNIQUE INDEX "characters_character_link_key" ON "characters"("character_link");

-- CreateIndex
CREATE UNIQUE INDEX "parodies_parodie_name_key" ON "parodies"("parodie_name");

-- CreateIndex
CREATE UNIQUE INDEX "parodies_parodie_link_key" ON "parodies"("parodie_link");

-- CreateIndex
CREATE UNIQUE INDEX "tags_tag_name_key" ON "tags"("tag_name");

-- CreateIndex
CREATE UNIQUE INDEX "tags_tag_link_key" ON "tags"("tag_link");

-- CreateIndex
CREATE INDEX "titlestoartists_id_artist_idx" ON "titlestoartists"("id_artist");

-- CreateIndex
CREATE INDEX "titlestogroups_id_group_idx" ON "titlestogroups"("id_group");

-- CreateIndex
CREATE INDEX "titlestocharacters_id_character_idx" ON "titlestocharacters"("id_character");

-- CreateIndex
CREATE INDEX "titlestoparodies_id_parodie_idx" ON "titlestoparodies"("id_parodie");

-- CreateIndex
CREATE INDEX "titlestotags_id_tag_idx" ON "titlestotags"("id_tag");

-- CreateIndex
CREATE INDEX "read_logs_read_at_idx" ON "read_logs"("read_at" DESC);

-- CreateIndex
CREATE INDEX "read_logs_hashtag_idx" ON "read_logs"("hashtag");

-- AddForeignKey
ALTER TABLE "titlestoartists" ADD CONSTRAINT "titlestoartists_hashtag_fkey" FOREIGN KEY ("hashtag") REFERENCES "titles"("hashtag") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "titlestoartists" ADD CONSTRAINT "titlestoartists_id_artist_fkey" FOREIGN KEY ("id_artist") REFERENCES "artists"("id_artist") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "titlestogroups" ADD CONSTRAINT "titlestogroups_hashtag_fkey" FOREIGN KEY ("hashtag") REFERENCES "titles"("hashtag") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "titlestogroups" ADD CONSTRAINT "titlestogroups_id_group_fkey" FOREIGN KEY ("id_group") REFERENCES "groups"("id_group") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "titlestocharacters" ADD CONSTRAINT "titlestocharacters_hashtag_fkey" FOREIGN KEY ("hashtag") REFERENCES "titles"("hashtag") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "titlestocharacters" ADD CONSTRAINT "titlestocharacters_id_character_fkey" FOREIGN KEY ("id_character") REFERENCES "characters"("id_character") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "titlestoparodies" ADD CONSTRAINT "titlestoparodies_hashtag_fkey" FOREIGN KEY ("hashtag") REFERENCES "titles"("hashtag") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "titlestoparodies" ADD CONSTRAINT "titlestoparodies_id_parodie_fkey" FOREIGN KEY ("id_parodie") REFERENCES "parodies"("id_parodie") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "titlestotags" ADD CONSTRAINT "titlestotags_hashtag_fkey" FOREIGN KEY ("hashtag") REFERENCES "titles"("hashtag") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "titlestotags" ADD CONSTRAINT "titlestotags_id_tag_fkey" FOREIGN KEY ("id_tag") REFERENCES "tags"("id_tag") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "read_logs" ADD CONSTRAINT "read_logs_hashtag_fkey" FOREIGN KEY ("hashtag") REFERENCES "titles"("hashtag") ON DELETE CASCADE ON UPDATE CASCADE;

