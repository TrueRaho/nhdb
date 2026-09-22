# nhdb

Personal collections with search, reading statistics and metadata scraping.
Next.js 16, React 19, Prisma 7, Neon Postgres and Neon Auth.

## Local setup

1. Copy `.env.example` to `.env` and fill in the database and Neon Auth values.
   Enable email/password sign-in and email verification in Neon Auth. The Auth
   endpoint and database must belong to the same Neon branch; allow localhost
   and your deployed origin in Auth's trusted domains.
2. Run `pnpm install --frozen-lockfile` (also generates the Prisma client).
3. Apply migrations to your intended development database with `pnpm db:deploy`.
4. Run `pnpm dev` and open http://localhost:3000. Create an account, verify your
   email, then sign in.

Each account has its own titles, tags, reading history, cache and browser scrape
queue. Server actions and API handlers derive the owner from the authenticated
session; the browser cannot select another collection.

## Scraper

The database is shared; the scraper is not. Every account runs its own and
registers it under **Account** (top right → `/account`):

1. Start one with `pnpm scraper` — on your own machine behind a tunnel, on a
   small container, anywhere reachable over https.
2. Add its URL as the **primary** host, plus its `SCRAPER_SECRET`.
3. Add as many **fallbacks** as you like; they are tried in order, top to bottom,
   whenever the one above is unreachable. A fast local box first and a slower
   always-on container behind it is the usual pairing.

Hosts must be `https` and resolve to a public address — the server refuses
private, loopback and link-local targets, and does not follow redirects. Secrets
are stored encrypted under `SCRAPER_CRED_KEY` and are never sent back to the
browser.

In development only, `SCRAPER_SERVICE_URL` / `SCRAPER_SERVICE_URL_FALLBACK` act
as a default when nothing is registered, so `pnpm dev` works against a local
`pnpm scraper` with no setup. Production ignores them.

## Existing collection

Migration `6_multi_user` preserves existing rows under `nhdb:unclaimed`. After
creating and verifying your account, assign those rows using the **user ID from
Neon Auth** (not your email), before adding titles to the account:

```sh
pnpm claim <neon-auth-user-id>
```

The transfer is atomic and refuses to merge into a nonempty collection. Run it
with the database credentials for the same branch, then restart the running app
to clear any previously cached empty collection. Existing unscoped browser scrape
queues are not imported because they do not identify their owner.

## Checks and deployment

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm exec next build  # compile without applying database migrations
```

Building needs `DATABASE_URL`, `NEON_AUTH_BASE_URL` and a cookie secret of at least
32 characters. `pnpm build` **also deploys database migrations** before compiling;
use the intended deployment branch. Migration 6 and the updated application must
be deployed together because the old client uses single-user keys.

## Scraper

`pnpm scraper` runs the standalone scraper. Set `SCRAPER_SERVICE_URL` (and
optionally `SCRAPER_SERVICE_URL_FALLBACK` / `SCRAPER_SECRET`) to use it from the app;
otherwise `/api/scrape` scrapes locally.

For `pnpm rescrape`, set `NHDB_SESSION_COOKIE` to the Cookie header from a
signed-in browser request. The command resolves the verified account from that
session and only reads/re-scrapes its collection. `--all`, `--list`, and
`--limit=N` are supported. `APP_URL` defaults to http://localhost:3000.
