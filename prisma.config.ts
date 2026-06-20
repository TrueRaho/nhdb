import "dotenv/config";
import { defineConfig } from "prisma/config";

// Migrations need a direct (unpooled) connection — advisory locks don't work
// through the PgBouncer pooler. Prefer the unpooled URL the Neon-Vercel
// integration injects; fall back to DATABASE_URL when it's the only one set.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url },
});
