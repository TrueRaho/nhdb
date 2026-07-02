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
pnpm scraper        # standalone scraper HTTP server on :3333 + ngrok tunnel
pnpm rescrape       # bulk re-scrape via the running app's /api/scrape
```

- `pnpm rescrape` (no flags) re-scrapes only tag-less titles; `--all`, `--list`,
  `--limit=N` are also supported. The app must be running.
- After any change to `prisma/schema.prisma`, run `pnpm prisma generate` — the
  client is generated to a **non-standard, gitignored** path (see below).
- There is **no test framework** in this repo.

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
- `ScrapeJobsProvider` runs background scrape jobs (localStorage-persisted),
  including retry handling for Render cold starts that exceed Vercel's 60 s
  budget.
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
