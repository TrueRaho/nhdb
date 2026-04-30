import { prisma } from "./db";
import type { ScrapeEntity, ScrapeResult } from "./scraper";

type EntityKind = "artist" | "group" | "character" | "parody" | "tag";

async function upsertEntity(kind: EntityKind, e: ScrapeEntity): Promise<number> {
  switch (kind) {
    case "artist":
      return (
        await prisma.artist.upsert({
          where: { artist_name: e.name },
          create: { artist_name: e.name, artist_link: e.link, total_works: e.total_works },
          update: { artist_link: e.link, total_works: e.total_works },
        })
      ).id_artist;
    case "group":
      return (
        await prisma.group.upsert({
          where: { group_name: e.name },
          create: { group_name: e.name, group_link: e.link, total_works: e.total_works },
          update: { group_link: e.link, total_works: e.total_works },
        })
      ).id_group;
    case "character":
      return (
        await prisma.character.upsert({
          where: { character_name: e.name },
          create: { character_name: e.name, character_link: e.link, total_works: e.total_works },
          update: { character_link: e.link, total_works: e.total_works },
        })
      ).id_character;
    case "parody":
      return (
        await prisma.parody.upsert({
          where: { parodie_name: e.name },
          create: { parodie_name: e.name, parodie_link: e.link, total_works: e.total_works },
          update: { parodie_link: e.link, total_works: e.total_works },
        })
      ).id_parodie;
    case "tag":
      return (
        await prisma.tag.upsert({
          where: { tag_name: e.name },
          create: { tag_name: e.name, tag_link: e.link, total_works: e.total_works },
          update: { tag_link: e.link, total_works: e.total_works },
        })
      ).id_tag;
  }
}

export async function upsertScrapedTitle(s: ScrapeResult) {
  const [artistIds, groupIds, characterIds, parodyIds, tagIds] = await Promise.all([
    Promise.all(s.artists.map((e) => upsertEntity("artist", e))),
    Promise.all(s.groups.map((e) => upsertEntity("group", e))),
    Promise.all(s.characters.map((e) => upsertEntity("character", e))),
    Promise.all(s.parodies.map((e) => upsertEntity("parody", e))),
    Promise.all(s.tags.map((e) => upsertEntity("tag", e))),
  ]);

  return prisma.$transaction(async (tx) => {
    const titleData = {
      titleName: s.title_name,
      alterName: s.alter_name,
      titleLink: s.title_link,
      imageLink: s.image_link,
      pages: s.pages,
      uploadedAt: new Date(s.uploaded_at),
    };

    await tx.title.upsert({
      where: { hashtag: s.hashtag },
      create: { hashtag: s.hashtag, ...titleData },
      update: titleData,
    });

    await Promise.all([
      tx.titleArtist.deleteMany({ where: { hashtag: s.hashtag } }),
      tx.titleGroup.deleteMany({ where: { hashtag: s.hashtag } }),
      tx.titleCharacter.deleteMany({ where: { hashtag: s.hashtag } }),
      tx.titleParody.deleteMany({ where: { hashtag: s.hashtag } }),
      tx.titleTag.deleteMany({ where: { hashtag: s.hashtag } }),
    ]);

    await Promise.all([
      artistIds.length &&
        tx.titleArtist.createMany({
          data: artistIds.map((id_artist) => ({ hashtag: s.hashtag, id_artist })),
        }),
      groupIds.length &&
        tx.titleGroup.createMany({
          data: groupIds.map((id_group) => ({ hashtag: s.hashtag, id_group })),
        }),
      characterIds.length &&
        tx.titleCharacter.createMany({
          data: characterIds.map((id_character) => ({ hashtag: s.hashtag, id_character })),
        }),
      parodyIds.length &&
        tx.titleParody.createMany({
          data: parodyIds.map((id_parodie) => ({ hashtag: s.hashtag, id_parodie })),
        }),
      tagIds.length &&
        tx.titleTag.createMany({
          data: tagIds.map((id_tag) => ({ hashtag: s.hashtag, id_tag })),
        }),
    ]);

    return tx.title.findUniqueOrThrow({
      where: { hashtag: s.hashtag },
      include: titleInclude,
    });
  });
}

const titleInclude = {
  artists: { include: { artist: true } },
  groups: { include: { group: true } },
  characters: { include: { character: true } },
  parodies: { include: { parody: true } },
  tags: { include: { tag: true } },
} as const;

export async function listTitles() {
  return prisma.title.findMany({
    orderBy: { createdAt: "desc" },
    include: titleInclude,
  });
}

export async function getTitle(hashtag: number) {
  return prisma.title.findUnique({
    where: { hashtag },
    include: titleInclude,
  });
}

export async function deleteTitle(hashtag: number) {
  return prisma.title.delete({ where: { hashtag } });
}

export async function markRead(hashtag: number) {
  return prisma.title.update({
    where: { hashtag },
    data: { readCount: { increment: 1 }, lastReadAt: new Date() },
  });
}

export async function updateAlterName(hashtag: number, alterName: string) {
  return prisma.title.update({
    where: { hashtag },
    data: { alterName: alterName.trim() || null },
  });
}
