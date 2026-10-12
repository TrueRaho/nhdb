# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

nhdb is a personal multi-user web app that catalogs a doujin collection. It
scrapes title metadata from any gallery site (no per-site code — see "Title
sources"), stores it in Neon Postgres via Prisma, and serves a
filterable/sortable gallery plus reading stats. Next.js 16 App Router,
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
- **The auth SDK writes cookies from Server Components, which Next forbids.**
  Past the 60 s session cache, `auth.getSession()` gets refreshed cookies back
  from Neon Auth and the stock `createNeonAuth` context throws on storing them
  — the first page load after a minute idle crashed. `lib/auth/server.ts`
  builds the server methods on a context that skips that write mid-render, and
  `proxy.ts` forwards the cache cookie it re-issues into the rendered request.
  Don't swap `auth` back to plain `createNeonAuth(...)`.
- **Leaving a page does not unmount it.** With Cache Components, Next keeps up
  to 3 visited routes alive in React `<Activity>` (hidden, `display: none`):
  coming back shows the same state, and every effect runs again (verified in
  this app: a layout-effect cleanup fires on leave, effects re-run on return).
  So `NhdbApp` re-queries its first page whenever you return to the gallery
  (its filters effect re-runs), and anything that must start fresh per visit
  resets itself in a `useLayoutEffect` cleanup — see `components/Swipe.tsx`.
- **Prisma client lives at `lib/generated/prisma/`**, not `@prisma/client`.
  Import `PrismaClient` / `Prisma` from `./generated/prisma/client` (see
  `lib/db.ts`, `lib/titles.ts`). The directory is gitignored, so a fresh clone
  must run `prisma generate` before typechecking.

## Architecture

### Tenancy

Neon Auth identifies each verified user. Pages, Server Actions and the scrape
API gate access through `lib/session.ts`; the proxy only improves navigation.
All `lib/titles.ts` functions take `userId` first, including cached reads. Resolve
it from the session outside `"use cache"`, never from client input. Titles use
`(user_id, hashtag)` keys; entities and joins belong to the same user, enforced by
composite foreign keys. Statistics, affinity and ghost tags are per collection.
Cache tags come from `lib/cache-tags.ts` and include the owner. Browser scrape
queues use `nhdb.scrapeJobs.v3:<userId>` (keyed by `source:id`) and reset when
accounts change.

Migration 6 parks legacy rows under `nhdb:unclaimed`; `pnpm claim <auth-user-id>`
transfers them atomically into an empty account. Restart the app after claiming
so any cached empty reads expire. See README for environment/setup steps.

Sign-up is open, so `/api/scrape` charges a per-user budget
(`lib/rate-limit.ts`, migration 7) before it spends real resources — the user's
scraper, and a serverless function held open for up to `maxDuration`.
It lives in Postgres **because** the app is serverless — an in-memory bucket is
per lambda instance, which multiplies the limit by the instance count. Charge it
only on paths that actually scrape: a commit of an already-scraped payload and a
malformed request both spend nothing. The single-statement upsert is what keeps
four concurrent pool scrapes from losing updates; don't split it into a read and
a write.

### Per-user scraper hosts

The collection is shared infrastructure; the scraper is not. Each user registers
their own hosts on `/account` (`scraper_endpoints`, migration 8), tried in
`position` order — the per-user version of the old ngrok-then-Render pair. In
production the `SCRAPER_SERVICE_URL*` env vars are **ignored**; they survive only
as a dev convenience, because a shared fallback would put everyone's scraping
back on one person's box.

Three things here are load-bearing and easy to undo:

- **The URL is user input that the server fetches**, i.e. SSRF. `lib/net-guard.ts`
  requires https, rejects every non-public resolved address (IPv4-mapped and
  NAT64 IPv6 unwrapped so `::ffff:169.254.169.254` cannot sneak through),
  re-checks DNS immediately before connecting, and the fetch sets
  `redirect: "error"`. Removing any one of those re-opens it.
- **Secrets are AES-GCM encrypted** (`lib/secret-box.ts`, `SCRAPER_CRED_KEY`) and
  never reach the browser — the UI gets `hasSecret`, not the value. A host whose
  secret will not decrypt is dropped, never called unauthenticated.
- **The list is rewritten whole** on save; positions are contiguous from 0, and a
  kept secret is carried over by URL so a reorder preserves it while repointing a
  row at another machine does not.

### Title sources (migrations `9_title_sources`, `9a_any_site_titles`)

A title comes from **any gallery site**. There is no site list and no per-site
code — the user asked for exactly that, so do not add one back ("support site
X" means a better generic rule plus a fixture, never an `if (host === …)`).

**Identity** (`lib/sources.ts`, client-safe; the paste box, `?add=`,
`/add/<link>`, `/api/scrape` and the scraper host all parse through it) is
`(source, id)`: `source` is the site's host name without `www.`/`m.`
(`siteKey`), and `id` is what `galleryIdOf` finds in the address — a gallery
word followed by an id (`/g/177013`, `/gallery/42/`, `/view/…`,
`/galleries/1234567.html`, `/manga/<slug>/`), a hex token after a number joins
it (`899557/edd545586a`), an `?id=` query, a long number, a slug ending in one,
a lone slug. Listing words as the first segment (`/tag/`, `/search`,
`/artist/`…) mean "not a title". **A wrong id is a data-loss bug, not a cosmetic
one**: two titles sharing `(source, id)` overwrite each other on upsert. So a
slug's number tail is not an id when it is a year (`summer-story-2019`), an
underscore tail counts only after a gallery word (Luscious `_456789`, never
hentai2read's `sister_1234`), and WordPress `?p=` counts only with no path
(elsewhere it is a page number) — lib/sources.test.ts pins colliding pairs. The string form is `source:id` (`refKey`;
`parseRefKey` reverses it). A `TitleRef` also carries the page `url` — the
address is stored (`titles.url`, migration 9a) because nothing can rebuild it.

**Seven legacy keys.** Rows saved before 9a carry `nhentai`, `ehentai`,
`hitomi`, `hentaifox`, `imhentai`, `pururin`, `hentai2read`; `siteKey` maps
those sites' hosts back to them so a new scrape lands on the same row, and
`galleryIdOf` produces exactly their old ids (lib/sources.test.ts pins it).
`LEGACY` also holds their canonical page templates (a pasted reader page
becomes the title page; `legacyUrl`/`titleUrl` cover rows without `url`). It is
a naming table for old rows, not a gate.

**`hashtag` is still the key everywhere** (joins, read log, cache tags, swipe,
URLs) — only its meaning split: an nhentai title's hashtag IS its gallery id
(< 1e9, so every pre-existing row, link and bookmark is unchanged); any other
site's title gets a surrogate ≥ 1e9 from `titles_foreign_hashtag_seq` on its
first save. `(user_id, source, source_id)` is unique and is what the add flow
dedupes on (`getTitlesByRefs`, uncached like `getTitlesByHashtags`). A CHECK
ties the halves together. Consequences worth knowing:

- A scraped-but-unsaved title from another site has **no hashtag** (`Item.hashtag`
  is 0 in `scrapedToItem`). Client code that needs identity before a save uses
  `itemKey`/refs, never the hashtag; the key a title is filed under is the one
  `upsertScrapedTitle` returns, never anything in the payload.
- Jobs and quick add **scrape by `ref.url`** and key by `refKey(ref)`; a key
  cannot be turned back into an address for a non-legacy site.
- Show a title with `itemLabel` ("#177013" stays as it was; "hentaifox 42"),
  name its site with `siteName` (the host), link it with `itemUrl` (= `item.url`),
  seed procedural art with `coverSeed` (nhentai keeps its hashtag seed; others
  seed from the ref so preview and saved match).
- **Covers go through `/api/cover`**, never straight from a CDN: render
  `coverSrc(imageLink, item.url)` with `unoptimized`. Some CDNs (Hitomi's) serve
  only requests whose Referer is the gallery's site, which the browser cannot
  send and the image optimizer will not forward, so the route fetches with the
  title page's origin as Referer (`lib/cover-proxy.ts`). With covers on any CDN
  there is no host allow-list: the SSRF defence is public-address DNS checks on
  every hop, web addresses only (no IP literals, credentials, ports), byte
  sniffing and a size cap — SECURITY.md. It reads the session cookie, which is
  why the optimizer is off (`images.unoptimized`, no `remotePatterns`).
  `NhCover` falls back to procedural art when a load fails.

**Reading a page** is `lib/scrapers/extract.ts` `readPage` — heuristics only:
the `<h1>` the document's `<title>` names, the info block around it (noise
containers — sidebar, related, comments, menus, tag clouds — excluded), what a
link is from namespace > row label > path words, count badges, `a | b`
aliases, format words, the doujin title convention, labeled page/date rows,
reader links, marked/lazy/CSS covers. It answers `gallery`, `follow` (content
warning, age gate, reader → gallery) or `none` (listing, 404, login wall,
article). **Measure changes against the corpus** (`lib/scrapers/fixtures/`,
run by `lib/scrapers/corpus.test.ts`): a tweak that fixes one site and breaks
another is not a fix. The corpus includes reconstructed and trimmed live pages, with credentials
and tracking removed. A failing live page becomes a new sanitised fixture;
cleanup must preserve its complete `readPage` result.

**Only title-shaped records of real pages get stored** — three independent
gates, see SECURITY.md: the address must look like one title's; the page must
read as one (and every fetch — pasted or followed, at most two hops, same site
— resolves to public addresses only); and the write boundary
`lib/scrape-payload.ts` (`parseScrapePayload`) re-derives every payload — a
site key, the stored `url` on that site naming the payload's id, a web-address
cover, entity links on the site (others dropped to ""), bounded strings/counts.
`/api/scrape` runs it on a host's answer too and refuses an answer about a
different title. It also reads the older shapes hosts send: nhentai-only
(`hashtag`, no `source`) and seven-site (legacy key, no `url`).

Entities are **shared across sites by name**: the boundary folds names to
lowercase NFKC (nhentai's vocabulary already was), so "Big Breasts" from Pururin
and "female:big breasts" from E-Hentai are nhentai's "big breasts". Two
consequences in `batchUpsertEntities`: a stored link is whichever site wrote it
last (links are write-only — and since 9a not unique: two spellings of one name
may share a link), and `total_works` is upserted as
`COALESCE(NULLIF(new, 0), current)` because only some sites print counts — a 0
means "this site did not say" and must not clobber nhentai's real count.

`uploaded_at` is **nullable**: several sites print no upload date, and dates are
never fabricated. `Item.uploadedAt` is `number | null`; the upload-date sort puts
nulls last.

The title row follows the same rule as `total_works` (`lib/title-upsert.ts`): a
re-scrape writes `pages`, `uploaded_at` and `image_link` as
`COALESCE(NULLIF(new, 0 / ''), current)` (the date: `COALESCE(new, current)`).
The reader stores 0 / null / "" when a page does not show a value, and the page
read now may show less than the one read before — Hitomi's gallery page has no
page count, which the old adapter read from the gallery script, so a plain
overwrite zeroed it. A first save still stores what it has.

### Caching contract (the part that's easy to break)

Read functions in `lib/titles.ts` are cached with `"use cache"` +
`cacheTag(...)` + `cacheLife("max")`. Tags are scoped by user via `lib/cache-tags.ts`: `titles-list:<userId>`,
`dataset:<userId>`, `stats:<userId>`, `title:<userId>:<hashtag>`,
`similar:<userId>:<hashtag>` and `similar:<userId>`. Any write must invalidate the
matching tags, and **which invalidation API you call depends on where you are**:

- **Server Actions** (`app/actions.ts`) → `updateTag(tag)` for read-your-writes
  semantics. `updateTag` is *only* allowed in Server Actions.
- **Route Handlers** (`app/api/scrape/route.ts`) → `revalidateTag(tag, "max")`
  (they can't call `updateTag`).

`getStats(userId, timeZone)` takes the **viewer's IANA zone** (the client passes
`Intl.DateTimeFormat().resolvedOptions().timeZone`; it is part of the cache
key, and an unknown zone falls back to UTC). It has to: `read_at`/`created_at`
are `timestamp` *without* zone holding UTC wall-clock, so hour-of-day and
day-of-week buckets reach local time via `read_at AT TIME ZONE 'UTC' AT TIME
ZONE <tz>` — two hops, and the first one is easy to forget. Comparisons against
`NOW()` go through `NOW() AT TIME ZONE 'UTC'` so nothing silently depends on
the DB session's `TimeZone`, and `read_at` is formatted to an ISO string *in
SQL* (the driver would otherwise parse a naive timestamp in the server
process's zone).

Deliberately **uncached**: `getTitlesByHashtags` and `getTitlesByRefs` — the add
flow uses them to decide whether to skip a re-scrape, so they must see live DB
state.

`getTagAffinity` deliberately reuses the **`dataset`** tag instead of getting
its own. Every write that can move a tag co-occurrence count (commit, delete)
already invalidates `dataset`, so there is no new call site to forget; the
writes that must *not* bust it (`markRead`, `updateAlterName`) correctly leave
it alone.

`sortField: "random"` is a deterministic seeded shuffle done in app code
(`hashMix`), not SQL `random()`, because `"use cache"` would freeze a SQL random
ordering. The client sends a fresh `seed` per new query and reuses it for "load
more" so pages don't overlap.

### Tag suggestions ("related tags")

`getTagAffinity(userId, {tags, mode})` answers "which *other* tags characterise the
titles matching this selection?", and the tag filter can OR the top few onto the
query to widen it. Scoring lives in `lib/affinity.ts`, ranked by the **lower
bound of the Wilson interval on P(B|A), divided by the tag's own base rate**.

Both obvious alternatives were evaluated and fail in opposite directions,
so don't "simplify" back to either:

- **Raw co-occurrence** ranks by popularity. Two tags each covering about half
  a collection can share many titles even under independence; a large shared
  count alone says little about their association.
- **Raw lift** ranks by smallness — every tag appearing *only* with the seed
  hits the same ceiling `1/f`, so several poorly supported tags can tie first.

`MIN_LIFT = 1.5` was chosen by sweeping 1.1 → 2.5: focused seeds were stable,
while a low floor let broad seeds expand until the filter barely filtered.
Raising the floor further discarded useful associations for broad seeds.
A tag on fraction `f` of the collection cannot exceed lift `1/f`, so a tag on
half the collection has a ceiling of 2 and legitimately gets few suggestions.
The Wilson lower bound penalises weak evidence before division by the base rate.

**No `tag_pairs` table, and don't add one.** The query scans only the seed set,
not the whole matrix. Evaluation found network round-trip latency dominated
query computation; precomputing would save little on a cache miss and add a
trigger to the serialized write path. Revisit if a single seed's join scan
approaches ~500k rows; benchmark on the deployment being considered.

**The suggested tags are never persisted.** They are recomputed on demand, and
the expansion in effect lives only in React state (`filters.tagsExpanded`,
alongside `expandTags` and `expandedFor`) — nothing is written to the database,
and filters reset on reload like every other filter. `QueryParams.tagsExpanded`
is kept separate from `QueryParams.tags` so the two stay distinguishable: only
the expansion widens, and the UI has to show which values it added on the
user's behalf. `expandedFor` stores the seed signature the list was computed
for; `appliedExpansion` in `NhdbApp` ignores the expansion whenever that
signature no longer matches the selection, which is what lets the fetch be the
only writer of those fields — nothing has to clear them when tags change.

In `buildWhere`, the expansion's `OR` wraps the base tag clause **as a whole**
(`{OR: [{AND: [...base]}, {in: expanded}]}`). OR-ing it alongside the individual
base clauses would silently downgrade the tags category's "all" mode to "any" —
`lib/titles.test.ts` pins this.

### Ghost tags (inferred per-title tags)

A separate feature from the tag suggestions above, solving a different problem:
a title an uploader tagged with three tags is unfindable, however good the
filter is. `getGhostIndex` in `lib/titles.ts` infers the tags such a title
*probably* carries, from the other works sharing its artist / group / parody /
characters; scoring is `lib/ghost.ts`.

**The features are complementary.** Related tags help narrow seeds find
informative neighbours. Ghosts help broad tags find titles through artist
profiles, where the lift ceiling leaves affinity little room. Keeping separate
controls lets users choose the kind of expansion they want.

**Affinity ranks by lift, ghosts rank by share.** "Which tags characterise
this selection?" wants the informative tag; "which tag is this title missing?"
wants the *probable* one. A rare tag A supported by few peers can have higher
lift than a common tag B supported by most peers, while being a worse prediction.

What the two *do* share lives in `lib/tagstats.ts`: `wilsonLowerBound` and
`STRUCTURAL_TAGS`, neither of which belongs to either feature. (Ghost inference
used to import them from `lib/affinity.ts`, which read as though it were built
on top of suggestion; they are siblings over a common base.) The scoring cores
are deliberately *not* shared: the overlap is about ten lines of arithmetic, and
merging them would put the two metrics behind one flag — a one-word edit on the
axis that determines which question is answered. Revisit at a **third** consumer; "what
characterises this artist?" is the plausible one, and `getGhostIndex` already
builds the per-entity tallies it would need.

Evaluation hid tags from well-tagged titles, left three visible, and measured
recall@10. Artist peers outperformed both popularity and naive Bayes over the
title's own tags. Combining artist peers with parody and nearest neighbours
added little for the extra machinery. This is why `lib/ghost.ts` ignores the
title's own tags as prediction evidence and keeps peer scoring simple.

`MIN_SHARE = 0.5` was chosen by sweeping 0.4 → 0.6: higher shares improved
precision at the cost of recall. `MIN_PEER_WORKS = 3` rejects peer groups too
small to support a prediction; `GHOST_LIMIT = 8` keeps the uncertain tail short.
`MIN_LIFT_OVER_BASE = 1.2` rejects catch-all peer groups: if tag A is as common
among those peers as in the collection, the group adds no evidence. This gate
works without a ban-list of entity names.

Ghost predictions remain uncertain. They are opt-in (`QueryParams.ghostTags`,
off by default), rendered as dashed outlines rather than filled chips, and
**never written to `titlestotags`** — they must not touch `tags.title_count`,
`avg_tag_value` or the stats.

In `buildWhere` the ghost `OR` goes *inside* each per-tag clause in "all" mode
(`{OR: [realHas(t), {hashtag: {in: ghostsOf(t)}}]}` per tag), never around the
group — wrapping the group would let one ghost satisfy the whole selection.
`lib/titles.test.ts` pins this. Ghosts also extend the search box, which is
where a missing title is looked for first.

Like the affinity query, this is computed and cached (under `dataset`), **not
materialised**: adding one work by an artist moves the ghosts of every other
work by that artist, so a stored table would need a recompute on the write path
that the serialized-write contract already constrains. The result is cached,
and `queryTitles` only pays the computation when `ghostTags` is set.

### Entity naming rules (migrations `5_split_aliases_and_normalize_links`, `9a`)

nhentai keeps every alias of one entity on a single tag page, separated by
`" | "` — `pensgfi | pencbfj`, `penvxcz | quill cuoi`. **All five
categories are split the same way**, for every site (`cleanName` in
`lib/scrapers/extract.ts`), so a title lists each name separately and a half
that also exists on its own stops being a duplicate row. (`" / "` is different:
it separates one name's English and Japanese spellings, and the first is kept.)

Know what the split costs before "fixing" it: the separator does **not** mean
the same thing everywhere. For artists and groups the halves really are separate
credits. For parodies it carries one work's Japanese and English titles, so
`penvxcz | quill cuoi` deliberately becomes two parody rows for one
franchise. Uniform tables were chosen over nhentai's semantics on purpose — do
not "restore" per-category behaviour without asking.

Entity `*_link` columns are stored **absolute** (`absoluteUrl` resolves the
markup's relative hrefs) and may be `""` (a row with no link, a link that left
the site, or one longer than the column). Both halves of a split name keep the
combined page's link — since 9a links are not unique, so nothing needs to be
derived. `total_works` is carried over to both halves rather than zeroed — it
is write-only data, and a zero would clobber a real count on the next
re-scrape's upsert.

### Two-layer scraper, hosted off Vercel

`lib/scraper.ts` is the orchestrator: it fetches `ref.url`, hands the HTML to
the site-agnostic `readPage` (`lib/scrapers/extract.ts`), follows what the
reading points at (≤ 2 hops, same site), and checks every address with
`assertPublicHostname` (`lib/net-address.ts` — deliberately not `server-only`,
the scraper host is plain Node) before fetching it. Two layers:

1. **impit** — TLS/HTTP2-impersonating HTTP client that passes Cloudflare's
   fingerprint gate without a browser (~200 ms). Fast path.
2. **Playwright** (playwright-extra + stealth) — a warm singleton browser used
   when impit is challenged **or** the page it got did not read as a title
   (client-rendered sites like Hitomi have no title until their scripts run);
   it waits for network idle instead of a site-specific selector. The response
   reports `via: "impit" | "fallback"`.
   Its HTTP(S) traffic, including redirects, passes through a loopback-only
   HTTP/CONNECT proxy (`lib/scraper-proxy.ts`) which checks all DNS answers and
   connects to the checked IP. Keep the proxy lifetime tied to the warm browser
   and force loopback through it; Playwright routes alone cannot guard redirects.

Every reading is passed through `parseScrapePayload` before it leaves the
scraper (`checked`), so a misread fails at the scraper with its reason. Only
nhentai has run against a live site for long; the generic reader is measured
against the fixture corpus — see SCRAPER.md "Verification status".

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

The triggers are `AFTER DELETE` **on the join tables**, so they only ever fire
for an entity that *had* a link and lost it — rows already orphaned when
migration 4 ran were unreachable by them and simply remained.
Migration 5 carries the one-time backfill sweep that migration 4 forgot; adding
a rule to a trigger is not the same as applying it to existing data.

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
and the existing dirs are integer-prefixed (`0_`–`9_`). `10_` sorts before
`2_`, and a timestamp prefix (`2026…`) sorts before `3_` — either would replay
out of order on a fresh database. After `9_` the slots are `9a_`, `9b_`, …
(`'_' < 'a'`, so `9a_` sorts right after `9_`; prisma/migration.test.ts reads
`/^\d+[a-z]?_/`) — 26 more without renaming anything. Past `9z_`,
rename+re-baseline (renames desync `_prisma_migrations`, so that is a
deliberate maintenance task, not a drive-by fix).

**Expand-only, because previews may migrate production.** `build` runs
`prisma migrate deploy`, and a preview deployment may point at the production
database, so a migration can be live while the previous code still serves.
Write migrations that the previous code survives (widen, relax, add nullable
columns, backfill); do a destructive step in a later migration once nothing
reads the old shape. 9a is the model.

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
  - **`/add/<link>`** (`app/add/[...input]/page.tsx` → `components/QuickAdd.tsx`)
    is the share-sheet target: **one** title from any supported site (or a bare
    nhentai id), with its alt-name field, and nothing else. It is its own
    route segment so Next's code splitting keeps the gallery, dataset and job
    pool off it — verified by the client-reference manifest, whose chunks for
    this page are `QuickAdd.tsx`'s alone (it may import the small client-safe
    `lib/sources`, `lib/mappers`, `lib/data`). Nothing links here; the URL is
    the only way in. Keep it that way: importing anything from `NhdbApp`'s tree
    (or adding a prefetching `<Link>`) silently undoes the whole point.
  - **`/?add=177013,895243`** (`DeepLinkAdd` in `NhdbApp`) is the batch path for
    the bookmarklet and pasted tab dumps: opens the add modal, queues the titles
    (ids or encoded links from any supported site), strips the param so a
    reload can't re-queue them.
  `parseInputs` (`lib/sources.ts`) backs the batch path and the paste box — it
  takes whole "Copy Links" tab dumps, links from every supported site, ids and
  prose mixed, and keeps only title links.
- **`/swipe`** (`app/swipe/page.tsx` → `components/Swipe.tsx`, rules in
  `lib/swipe.ts`) goes through the titles that have **no alter name**, one
  full-screen cover at a time, reshuffled on every visit (the deck is fetched as
  hashtags, shuffled in the browser, and loaded a few cards ahead). Right keeps
  a title — only with a name typed in, saved through `updateAlterNameAction`,
  which is also what keeps it out of later decks. Left puts it on a deletion
  list; down brings it back `POSTPONE_GAP` cards later; up is not assigned yet.
  A tap opens the title on its own site **without** `markRead`: a pass over a
  few hundred unnamed titles would otherwise flood the reading stats. The deletion list is a list
  of intentions, so it lives in localStorage per account
  (`nhdb.swipe.trash.v1:<userId>`), not in the database; `deleteTitlesAction`
  empties it with ONE `DELETE` (the serialized-write contract). Like `/add/<id>`
  it is its own segment and imports nothing from `NhdbApp`'s tree; it mounts
  client-only (`components/SwipeEntry.tsx`) because it reads storage on setup.
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
