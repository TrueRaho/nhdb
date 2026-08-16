# Scraper service for Render (https://render.com).
#
# The Playwright base image ships Chromium + every system library it needs, so
# the browser fallback works out of the box. impit (the fast first layer) needs
# none of it. The tag MUST match the locked `playwright` version (pnpm-lock.yaml)
# or chromium.launch() throws "Executable doesn't exist" — the `playwright
# install` below is the safety net that downloads the right browser build when
# the tag has drifted, at the cost of a fatter image layer.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# The image bundles Node 20 + corepack; activate the pnpm version pinned in package.json.
RUN corepack enable

# .dockerignore keeps node_modules/.next/.env/.git out, so this copies source only.
COPY . .

# Full install — dotenv is a devDependency the server imports, and `--prod=false`
# guards against an inherited NODE_ENV=production trimming devDependencies.
#
# No DATABASE_URL needed: prisma.config.ts's presence check is lazy (it fires only
# when a command actually connects), the `prisma generate` that postinstall runs
# never connects, and the scraper itself never touches a database.
RUN pnpm install --frozen-lockfile --prod=false

# No-op when the base image tag matches the installed playwright; downloads the
# matching Chromium build when it doesn't. Keeps a version bump in package.json
# from silently killing the browser fallback (which is the whole point of this
# host — impit is always Cloudflare-challenged on Render's datacenter IPs).
RUN pnpm exec playwright install chromium

# Render injects PORT at runtime; the server reads it. Exposed for documentation.
EXPOSE 3333

CMD ["pnpm", "scraper"]
