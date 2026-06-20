# Scraper service for Render (https://render.com).
#
# The Playwright base image ships Chromium + every system library it needs, so
# the browser fallback works out of the box. impit (the fast first layer) needs
# none of it. The tag matches our `playwright` version so browser revisions line up.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# The image bundles Node 20 + corepack; activate the pnpm version pinned in package.json.
RUN corepack enable

# .dockerignore keeps node_modules/.next/.env/.git out, so this copies source only.
COPY . .

# Full install — dotenv is a devDependency the server imports, and `--prod=false`
# guards against an inherited NODE_ENV=production trimming devDependencies.
#
# A throwaway DATABASE_URL only satisfies prisma.config.ts's presence check during
# the `prisma generate` that pnpm runs on install — generate never connects to a
# database, and the scraper itself never touches one.
RUN DATABASE_URL="postgresql://user:pass@localhost:5432/db" \
    pnpm install --frozen-lockfile --prod=false

# Render injects PORT at runtime; the server reads it. Exposed for documentation.
EXPOSE 3333

CMD ["pnpm", "scraper"]
