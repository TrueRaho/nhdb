# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

nhdb is a personal single-user web app that catalogs an nhentai collection. It
scrapes title metadata from nhentai, stores it in Neon Postgres via Prisma, and
serves a filterable/sortable gallery plus reading stats. Next.js 16 App Router,
React 19, Tailwind v4, pnpm.

## Commands

```bash
pnpm dev            # next dev — drive it via http://localhost:3000 (see gotcha below)
pnpm build          # prisma migrate deploy && prisma generate && next build
pnpm lint           # eslint
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run (pnpm test:watch to iterate)
pnpm scraper        # standalone scraper HTTP server on :3333 + ngrok tunnel
pnpm rescrape       # bulk re-scrape via the running app's /api/scrape
```

- `pnpm rescrape` (no flags) re-scrapes only tag-less titles; `--all`, `--list`,
  `--limit=N` are also supported. The app must be running.
- After any change to `prisma/schema.prisma`, run `pnpm prisma generate` — the
  client is generated to a **non-standard, gitignored** path (see below).
- Tests are **vitest** (`*.test.ts(x)` next to the code). Default environment is
  node (parsers, mappers, the /api/scrape route with mocked deps); component
  tests opt into jsdom per file via a `// @vitest-environment jsdom` docblock
  (see `components/ScrapeJobsProvider.test.tsx`, which covers the scrape pool).
  `.github/workflows/ci.yml` runs lint + typecheck + test on every PR; it needs
  no secrets, because `prisma generate` never connects.

## Non-obvious gotchas

- **Dev server: use `localhost`, not `127.0.0.1`.** Next 16's dev bundle blocks
  on `127.0.0.1` and renders a blank page.
- **This is Next.js 16 with breaking changes vs. training data** (per AGENTS.md).
  Read the relevant guide in `node_modules/next/dist/docs/` before writing Next
  code — the caching/`"use cache"` APIs in particular are new.
- **Prisma client lives at `lib/generated/prisma/`**, not `@prisma/client`.
  Import `PrismaClient` / `Prisma` from `./generated/prisma/client` (see
  `lib/db.ts`, `lib/titles.ts`). The directory is gitignored, so a fresh clone
  must run `prisma generate` before typechecking.

## Architecture

### Caching contract (the part that's easy to break)

Read functions in `lib/titles.ts` are cached with `"use cache"` +
`cacheTag(...)` + `cacheLife("max")`. Tags in use: `titles-list`, `dataset`,
`stats`, `title-<hashtag>`, `similar-<hashtag>`. Any write must invalidate the
matching tags, and **which invalidation API you call depends on where you are**:

- **Server Actions** (`app/actions.ts`) → `updateTag(tag)` for read-your-writes
  semantics. `updateTag` is *only* allowed in Server Actions.
- **Route Handlers** (`app/api/scrape/route.ts`) → `revalidateTag(tag, "max")`
  (they can't call `updateTag`).

`getStats(timeZone)` takes the **viewer's IANA zone** (the client passes
`Intl.DateTimeFormat().resolvedOptions().timeZone`; it is part of the cache
key, and an unknown zone falls back to UTC). It has to: `read_at`/`created_at`
are `timestamp` *without* zone holding UTC wall-clock, so hour-of-day and
day-of-week buckets reach local time via `read_at AT TIME ZONE 'UTC' AT TIME
ZONE <tz>` — two hops, and the first one is easy to forget. Comparisons against
`NOW()` go through `NOW() AT TIME ZONE 'UTC'` so nothing silently depends on
the DB session's `TimeZone`, and `read_at` is formatted to an ISO string *in
SQL* (the driver would otherwise parse a naive timestamp in the server
process's zone).

Deliberately **uncached**: `getTitlesByHashtags` — the add flow uses it to
decide whether to skip a re-scrape, so it must see live DB state.

`sortField: "random"` is a deterministic seeded shuffle done in app code
(`hashMix`), not SQL `random()`, because `"use cache"` would freeze a SQL random
ordering. The client sends a fresh `seed` per new query and reuses it for "load
more" so pages don't overlap.

### Two-layer scraper, hosted off Vercel

`lib/scraper.ts` scrapes in two layers:

1. **impit** — TLS/HTTP2-impersonating HTTP client that passes nhentai's
   Cloudflare fingerprint gate without a browser (~200 ms). Fast path.
2. **Playwright** (playwright-extra + stealth) — a warm singleton browser used
   *only* when impit is challenged. The response reports `via: "impit" |
   "fallback"`.

Both are lazily imported so proxy-mode Vercel never loads their native binaries;
they're also listed in `serverExternalPackages` in `next.config.ts`.

The scraper can't run on Vercel (no Chromium), so `app/api/scrape/route.ts` is a
**proxy** to external scraper hosts, tried in order:
`SCRAPER_SERVICE_URL` (primary — local box via ngrok, residential IP where impit
passes fast) then `SCRAPER_SERVICE_URL_FALLBACK` (Render backup, always pays the
slow browser fallback). A *definitive* verdict (404/400) from the primary is
returned as-is; only an *unreachable* primary falls through. `scripts/scraper-server.ts`
is the standalone host (runs the same `scrapeTitle`, adds ngrok + Render lifecycle).
Full topology is in `SCRAPER.md`.

### Postgres-maintained invariants (migrations `3_avg_tag_value`, `4_orphan_cleanup_triggers`)

Two kinds of DB-maintained data, both kept correct by triggers instead of app code:

**Denormalized stats** — `tags.title_count` (how many titles carry a tag) and
`titles.avg_tag_value` (mean of a title's tags' `title_count`) are maintained by
**statement-level triggers on `titlestotags`** (migration 3); the `avg-tag-value`
sort reads the denormalized column directly. They fire on **any** statement that
mutates `titlestotags` — including the DELETE Postgres runs internally for an FK
`ON DELETE CASCADE` (verified on PG17/Neon: the cascaded delete populates the
trigger's `OLD TABLE` transition table and recomputes the counts).

**Orphan-entity cleanup** — entities (artists/groups/characters/parodies/tags)
left with zero titles are removed by **deferred constraint triggers** on the five
join tables (migration 4). They are `DEFERRABLE INITIALLY DEFERRED` (fire at
COMMIT) *on purpose*: `upsertScrapedTitle` re-scrapes by delete+recreating a
title's join rows in one transaction, and an *immediate* trigger would delete an
entity the instant its old link was removed, so the re-insert would FK-violate.
Deferring to commit lets a re-referenced entity survive (only genuine orphans go)
and also cleans up entities dropped on re-scrape, which the old app-side cleanup
missed.

Because of both, `deleteTitle` in `lib/titles.ts` is just
`prisma.title.deleteMany({ where: { hashtag } })` — the cascade removes the join
rows, the stat triggers recompute, and the deferred triggers drop orphans; no
app-side id-collection or cleanup. (A prior comment claimed cascade would *not*
fire the stat trigger and forced an explicit `titleTag.deleteMany` — false,
removed.) Migration 4 is created but applies on deploy (`build` runs
`prisma migrate deploy`); locally run `pnpm db:deploy` after pulling it.

### Migrations

Migrations are hand-authored raw SQL under `prisma/migrations/` (triggers and
column drops can't be expressed in `schema.prisma`). `prisma.config.ts` runs
migrations against `DATABASE_URL_UNPOOLED` — advisory locks don't work through
Neon's PgBouncer pooler, so migrations need the direct connection.

**Naming trap**: prisma replays migrations in *lexicographic* directory order,
and the existing dirs are integer-prefixed (`0_`–`4_`). `10_` sorts before
`2_`, and a timestamp prefix (`2026…`) sorts before `3_` — either would replay
out of order on a fresh database. Name new migrations `5_`–`9_`; before a tenth
exists, rename+re-baseline (renames desync `_prisma_migrations`, so that is a
deliberate maintenance task, not a drive-by fix).

**Concurrency contract**: the stat triggers (migration 3) recompute
`tags.title_count` with `COUNT(*)` under READ COMMITTED — concurrent writing
transactions can overwrite each other's counts. The app therefore keeps writes
serialized: `commitReady` commits one title at a time, and entity upserts run
*inside* the `upsertScrapedTitle` transaction. Don't parallelize either without
first making the triggers delta-based.

### Data flow & frontend

- `app/page.tsx` (server) fetches the first page + `getDataset()` and hands them
  to `NhdbApp` as initial props. Subsequent queries go through the
  `queryTitlesAction` server action.
- DB rows → client `Item` shape via `dbTitleToItem` (`lib/mappers.ts`), which
  converts dates to "days ago" integers (rendered by `daysAgoLabel` in
  `lib/utils.ts`).
- `NhdbApp` picks a mobile vs. `Desktop` layout at runtime via `matchMedia`,
  staying `null` until mounted so phones never download the desktop chunk and
  there's no hydration mismatch. `DetailModal`, `AddModal`, `Stats`, `Desktop`
  are all `dynamic(..., { ssr: false })`.
- `ScrapeJobsProvider` syncs its job list **across tabs** through the `storage`
  event. The merge is deliberately symmetric (higher `STATUS_RANK` wins, ties go
  to the remote) — a "mine wins" rule makes two tabs overwrite each other
  forever — and a job only one tab knows about survives while that tab drives
  it. Adopted `scraping` jobs land in the `foreign` set so the adopting tab
  displays but does not re-fetch them.
- `ScrapeJobsProvider` runs background scrape jobs (localStorage-persisted),
  including retry handling for Render cold starts that exceed Vercel's 60 s
  budget. Jobs go through a **pool capped at 4 concurrent scrapes** — a pasted
  phone tab dump queues dozens at once, and firing them together floods the single
  ngrok tunnel or spawns dozens of parallel Playwright launches on the free Render box.
- Two ways titles arrive from a phone, deliberately separate:
  - **`/add/<id>`** (`app/add/[input]/page.tsx` → `components/QuickAdd.tsx`) is
    the share-sheet target: **one** title, with its alt-name field, and nothing
    else. It is its own route segment so Next's code splitting keeps the
    gallery, dataset and job pool off it — verified by the client-reference
    manifest, which lists only `QuickAdd.tsx`. Nothing links here; the URL is
    the only way in. Keep it that way: importing anything from `NhdbApp`'s tree
    (or adding a prefetching `<Link>`) silently undoes the whole point.
  - **`/?add=177013,895243`** (`DeepLinkAdd` in `NhdbApp`) is the batch path for
    the bookmarklet and pasted tab dumps: opens the add modal, queues the ids,
    strips the param so a reload can't re-queue them.
  `parseInputs` (`lib/utils.ts`) backs the batch path and the paste box — it
  takes whole "Copy Links" tab dumps, ids and prose mixed.
- `SpeedInsights`/`Analytics` live in `app/page.tsx`, **not** the root layout,
  so `/add/<id>` ships neither script.
- `alterName` is a **user-managed** custom title; the scraper never writes it,
  on create or re-scrape.

## Stack notes

- **shadcn** with `style: "base-nova"` on **`@base-ui/react`** (not Radix).
  Aliases: `@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`.
- **Prisma 7** via `@prisma/adapter-neon` (Neon WebSocket pool) — works
  serverless while still supporting interactive transactions. `lib/db.ts`
  singletons the client across dev hot reloads.
- Env vars (server-only, via `lib/env.ts`): `DATABASE_URL`,
  `DATABASE_URL_UNPOOLED`, `SCRAPER_SERVICE_URL`, `SCRAPER_SERVICE_URL_FALLBACK`,
  `SCRAPER_SECRET`.
