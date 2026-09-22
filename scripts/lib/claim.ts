export const UNCLAIMED_USER_ID = "nhdb:unclaimed";

// Only these fixed identifiers are interpolated into SQL; the supplied owner is
// always a parameter. Keep the whole plan in one transaction.
export const COLLECTION_TABLES = [
  "titles", "artists", "groups", "characters", "parodies", "tags",
  "titlestoartists", "titlestogroups", "titlestocharacters",
  "titlestoparodies", "titlestotags", "read_logs",
] as const;

export function claimStatements(userId: string): { text: string; values: string[] }[] {
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(userId) || userId === UNCLAIMED_USER_ID) {
    throw new Error("Supply a valid Neon Auth user ID (1–64 letters, digits, :, _ or -), not the unclaimed owner.");
  }

  const owners = COLLECTION_TABLES.map((table) => `SELECT user_id FROM "${table}"`).join(" UNION ALL ");
  return [
    { text: "SET LOCAL lock_timeout = '10s'", values: [] },
    // Prevent a scrape/second claim from inserting rows between the empty-target
    // check and the transfer. Reads remain available during this one-time job.
    { text: `LOCK TABLE ${COLLECTION_TABLES.map((table) => `"${table}"`).join(", ")} IN SHARE ROW EXCLUSIVE MODE`, values: [] },
    { text: "SET CONSTRAINTS ALL DEFERRED", values: [] },
    { text: "SELECT set_config('nhdb.claim_user', $1, true)", values: [userId] },
    {
      text: `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM (${owners}) owners WHERE user_id = '${UNCLAIMED_USER_ID}')
          AND EXISTS (SELECT 1 FROM (${owners}) owners WHERE user_id = current_setting('nhdb.claim_user')) THEN
          RAISE EXCEPTION 'The target user already has a collection. Claim into an empty account to avoid merging or losing data.';
        END IF;
      END $$`,
      values: [],
    },
    ...COLLECTION_TABLES.map((table) => ({
      text: `UPDATE "${table}" SET user_id = $1 WHERE user_id = $2`,
      values: [userId, UNCLAIMED_USER_ID],
    })),
  ];
}
