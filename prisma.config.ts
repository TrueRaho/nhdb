import "dotenv/config";
import { defineConfig } from "prisma/config";

// Migrations need a direct (unpooled) connection — advisory locks don't work
// through the PgBouncer pooler. Prefer the unpooled URL the Neon-Vercel
// integration injects; fall back to DATABASE_URL when it's the only one set.
//
// The presence check is lazy (a getter) so it only fires when a command
// actually needs a connection. `prisma generate` never connects, so it — and
// the `postinstall` hook that runs it — works on a fresh clone with no
// DATABASE_URL / .env instead of aborting the whole install.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    get url() {
      const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is not set");
      return url;
    },
  },
});
