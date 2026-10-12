// Read-only P5 audit. No scraper calls, migrations, UPDATE/INSERT or repair mode.
// Offline: pnpm audit:ids --from-json=export.json [--since=2026-10-05]
// DB:      pnpm audit:ids --database [--since=2026-10-05]
// DB mode requires DATABASE_URL, APP_URL and NHDB_SESSION_COOKIE, as rescrape does.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AUDIT_TITLES_SQL, auditSince, auditTitleIds, DEFAULT_AUDIT_SINCE, parseAuditTitles } from "./lib/audit-title-ids";

async function main() {
  const { values } = parseArgs({ options: {
    "from-json": { type: "string" }, database: { type: "boolean" },
    since: { type: "string", default: DEFAULT_AUDIT_SINCE }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: pnpm audit:ids (--from-json=export.json | --database) [--since=YYYY-MM-DD]\nRead-only; outputs JSON. Snapshot fields: user_id, hashtag, source, source_id, url, title_name, created_at.\nDB mode: verified NHDB_SESSION_COOKIE, APP_URL, DATABASE_URL. Cutoff inclusive, UTC.");
    return;
  }
  auditSince(values.since!);
  if (!!values["from-json"] === !!values.database) throw new Error("Choose exactly one of --from-json or --database (see --help)");
  let raw: unknown;
  if (values["from-json"]) {
    // Offline mode does not load .env, fetch a session or import the DB client.
    raw = JSON.parse(await readFile(values["from-json"], "utf8"));
  } else {
    const { config } = await import("dotenv");
    config({ path: [".env.local", ".env"], quiet: true });
    const cookie = process.env.NHDB_SESSION_COOKIE?.trim();
    const connectionString = process.env.DATABASE_URL;
    if (!cookie || !connectionString) throw new Error("Set NHDB_SESSION_COOKIE and DATABASE_URL for --database");
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const headers: Record<string, string> = { Cookie: cookie };
    if (bypass) headers["x-vercel-protection-bypass"] = bypass;
    let userId: string;
    try {
      const response = await fetch(`${process.env.APP_URL ?? "http://localhost:3000"}/api/auth/get-session`, {
        headers, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("session unavailable");
      const session = await response.json();
      if (typeof session?.user?.id !== "string" || !session.user.id || session.session?.userId !== session.user.id || session.user.emailVerified !== true) {
        throw new Error("session unverified");
      }
      userId = session.user.id;
    } catch {
      throw new Error("A verified signed-in session is required; session lookup failed");
    }
    try {
      const { neon } = await import("@neondatabase/serverless");
      const sql = neon(connectionString);
      const results = await sql.transaction([sql.query(AUDIT_TITLES_SQL, [userId])], {
        readOnly: true, isolationLevel: "RepeatableRead", fetchOptions: { signal: AbortSignal.timeout(30_000) },
      });
      raw = results[0];
    } catch {
      // Driver errors can include connection details; do not print secrets.
      throw new Error("Read-only database query failed; check database configuration and access");
    }
    const rows = parseAuditTitles(raw);
    if (rows.some((row) => row.user_id !== userId)) throw new Error("Database returned rows outside the verified collection");
    raw = rows;
  }
  console.log(JSON.stringify(auditTitleIds(parseAuditTitles(raw), values.since), null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "ID audit failed");
  process.exitCode = 1;
});
