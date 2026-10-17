import type { Prisma } from "./generated/prisma/client";
import { consumeUsageBudget } from "./usage-budget";
import { EXPORT_LIMIT } from "./usage-limits";
import { titleUrl } from "./sources";

export const TITLE_EXPORT_BATCH = 250;
export const READ_LOG_EXPORT_BATCH = 1000;

// Explicit allow-list: never query endpoints, credentials, sessions or budgets.
const TITLE_FIELDS = {
  hashtag: true, source: true, sourceId: true, url: true,
  titleName: true, alterName: true, imageLink: true, pages: true,
  uploadedAt: true, createdAt: true, readCount: true, lastReadAt: true,
  artists: { select: { artist: { select: { artistName: true, artistLink: true, totalWorks: true } } } },
  groups: { select: { group: { select: { groupName: true, groupLink: true, totalWorks: true } } } },
  parodies: { select: { parody: { select: { parodieName: true, parodieLink: true, totalWorks: true } } } },
  characters: { select: { character: { select: { characterName: true, characterLink: true, totalWorks: true } } } },
  tags: { select: { tag: { select: { tagName: true, tagLink: true, totalWorks: true } } } },
} satisfies Prisma.TitleSelect;

type ExportDb = Pick<Prisma.TransactionClient, "$queryRaw" | "title" | "readLog">;
type ExportTitle = Prisma.TitleGetPayload<{ select: typeof TITLE_FIELDS }>;

function exportedTitle(t: ExportTitle) {
  return {
    ...t, url: titleUrl(t.source, t.sourceId, t.url),
    artists: t.artists.map(({ artist: e }) => ({ name: e.artistName, link: e.artistLink, totalWorks: e.totalWorks })),
    groups: t.groups.map(({ group: e }) => ({ name: e.groupName, link: e.groupLink, totalWorks: e.totalWorks })),
    parodies: t.parodies.map(({ parody: e }) => ({ name: e.parodieName, link: e.parodieLink, totalWorks: e.totalWorks })),
    characters: t.characters.map(({ character: e }) => ({ name: e.characterName, link: e.characterLink, totalWorks: e.totalWorks })),
    tags: t.tags.map(({ tag: e }) => ({ name: e.tagName, link: e.tagLink, totalWorks: e.totalWorks })),
  };
}

export async function exportCollection(db: ExportDb, userId: string): Promise<ReadableStream<Uint8Array>> {
  if (!userId) throw new Error("Missing user ID");
  // Complete the charge before creating any stream, so denials are normal 429s.
  await consumeUsageBudget(db, {
    kind: "export", userId, amount: 1, limit: EXPORT_LIMIT, period: "day",
    message: `Export limit reached (${EXPORT_LIMIT}/day). Try again tomorrow.`,
  });
  const startedAt = new Date();
  const [titles, logs] = await Promise.all([
    db.title.aggregate({ where: { userId, createdAt: { lte: startedAt } }, _max: { hashtag: true } }),
    db.readLog.aggregate({ where: { userId, readAt: { lte: startedAt } }, _max: { id: true } }),
  ]);
  const maxHashtag = titles._max.hashtag;
  const maxLogId = logs._max.id;
  const encoder = new TextEncoder();

  // No transaction spans this generator. Start-time and key bounds exclude new
  // records; concurrent edits/deletes can still change or omit existing rows.
  async function* chunks() {
    yield encoder.encode(`{"version":1,"exportedAt":${JSON.stringify(startedAt.toISOString())},"titles":[`);
    let lastHashtag: number | undefined;
    let first = true;
    while (maxHashtag !== null) {
      const batch = await db.title.findMany({
        where: {
          userId, createdAt: { lte: startedAt },
          hashtag: { lte: maxHashtag, ...(lastHashtag === undefined ? {} : { gt: lastHashtag }) },
        },
        orderBy: { hashtag: "asc" }, take: TITLE_EXPORT_BATCH, select: TITLE_FIELDS,
      });
      for (const title of batch) {
        yield encoder.encode(`${first ? "" : ","}${JSON.stringify(exportedTitle(title))}`);
        first = false;
      }
      if (batch.length < TITLE_EXPORT_BATCH) break;
      lastHashtag = batch[batch.length - 1].hashtag;
      if (lastHashtag >= maxHashtag) break;
    }
    yield encoder.encode('],"readLog":[');
    let lastRead: { id: number; readAt: Date } | undefined;
    first = true;
    while (maxLogId !== null) {
      const batch = await db.readLog.findMany({
        where: {
          userId, id: { lte: maxLogId }, readAt: { lte: startedAt },
          ...(lastRead ? { OR: [
            { readAt: { gt: lastRead.readAt } },
            { readAt: lastRead.readAt, id: { gt: lastRead.id } },
          ] } : {}),
        },
        orderBy: [{ readAt: "asc" }, { id: "asc" }], take: READ_LOG_EXPORT_BATCH,
        select: { id: true, hashtag: true, readAt: true },
      });
      for (const log of batch) {
        yield encoder.encode(`${first ? "" : ","}${JSON.stringify(log)}`);
        first = false;
      }
      if (batch.length < READ_LOG_EXPORT_BATCH) break;
      lastRead = batch[batch.length - 1];
    }
    yield encoder.encode("]}");
  }

  const iterator = chunks();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch {
        // Headers have already gone out. Abort the download rather than send
        // valid-looking partial JSON or expose database/credential details.
        controller.error(new Error("Collection export interrupted. Download it again."));
      }
    },
    async cancel() { await iterator.return(undefined); },
  }, { highWaterMark: 0 });
}
