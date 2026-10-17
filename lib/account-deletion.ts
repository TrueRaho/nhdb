// Connection-free statements shared with the gated PostgreSQL tests.
import { Prisma } from "./generated/prisma/client";
import { userWriteLockSql } from "./usage-budget";

export function accountDeletionSql(userId: string): Prisma.Sql[] {
  if (!userId) throw new Error("Missing user ID");
  // Sweep pre-existing orphans first: deferred join-delete triggers cannot
  // see entities that never had a join. Newly orphaned entities stay until COMMIT.
  const entities = [
    ["artists", "titlestoartists", "id_artist"],
    ["groups", "titlestogroups", "id_group"],
    ["characters", "titlestocharacters", "id_character"],
    ["parodies", "titlestoparodies", "id_parodie"],
    ["tags", "titlestotags", "id_tag"],
  ];
  return [
    userWriteLockSql(userId),
    ...entities.map(([table, joins, id]) => Prisma.sql`
      DELETE FROM ${Prisma.raw(table)} e WHERE e.user_id = ${userId}
      AND NOT EXISTS (SELECT 1 FROM ${Prisma.raw(joins)} j
        WHERE j.user_id = e.user_id AND j.${Prisma.raw(id)} = e.${Prisma.raw(id)})
    `),
    // One title DELETE; cascades and deferred triggers do the linked cleanup.
    Prisma.sql`DELETE FROM titles WHERE user_id = ${userId} RETURNING hashtag`,
    Prisma.sql`DELETE FROM read_logs WHERE user_id = ${userId}`,
    Prisma.sql`DELETE FROM scraper_endpoints WHERE user_id = ${userId}`,
    // Retain quota counters: a surviving login must not regain fresh limits.
  ];
}

export async function deleteAccountData(db: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">, userId: string) {
  const hashtags: number[] = [];
  // Sequential statements preserve the trigger/write contract.
  for (const statement of accountDeletionSql(userId)) {
    if (statement.text.includes("RETURNING hashtag")) {
      const rows = await db.$queryRaw<{ hashtag: number }[]>(statement);
      hashtags.push(...rows.map((row) => row.hashtag));
    } else {
      // In particular, pg_advisory_xact_lock returns PostgreSQL void, which
      // Prisma cannot deserialize through $queryRaw. Match the existing writes.
      await db.$executeRaw(statement);
    }
  }
  return hashtags;
}
