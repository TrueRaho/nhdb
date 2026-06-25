// Prisma 7 client. Uses @prisma/adapter-neon (PrismaNeon → a Neon WebSocket
// Pool) so it works in serverless environments while still supporting
// interactive transactions. Singleton across hot reloads in dev.

import { PrismaClient } from "./generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { env } from "./env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function build(): PrismaClient {
  const adapter = new PrismaNeon({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? build();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
