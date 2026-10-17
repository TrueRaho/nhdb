import { Prisma } from "./generated/prisma/client";
import { READ_DEDUPE_MINUTES } from "./usage-limits";

// Shared by markRead and DB-backed tests: one owner-scoped conditional write.
// Run after userWriteLockSql, then charge only a returned row in the same tx.
export function markReadSql(userId: string, hashtag: number): Prisma.Sql {
  return Prisma.sql`
    UPDATE titles SET read_count = read_count + 1, last_read_at = NOW() AT TIME ZONE 'UTC'
    WHERE user_id = ${userId} AND hashtag = ${hashtag}
      AND (last_read_at IS NULL OR last_read_at <= (NOW() AT TIME ZONE 'UTC') - ${READ_DEDUPE_MINUTES} * INTERVAL '1 minute')
    RETURNING read_count
  `;
}
