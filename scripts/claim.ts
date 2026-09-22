// Assign the legacy collection after signing up, before adding any titles:
//   pnpm claim <neon-auth-user-id>
// All tables move atomically; existing target collections are never merged.
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { claimStatements, COLLECTION_TABLES } from "./lib/claim";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: pnpm claim <neon-auth-user-id>");
  const statements = claimStatements(args[0]);
  const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const sql = neon(connectionString, { fullResults: true });
  const results = await sql.transaction(statements.map(({ text, values }) => sql.query(text, values)));
  const updates = results.slice(-COLLECTION_TABLES.length);
  const total = updates.reduce((sum, result) => sum + result.rowCount, 0);
  if (!total) {
    console.log("No unclaimed collection remains.");
    return;
  }
  console.log(`Claimed ${updates[0].rowCount} titles (${total} rows) for ${args[0]}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Claim failed");
  process.exitCode = 1;
});
