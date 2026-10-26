# nhdb

**A home for your doujin collection.**

If you read doujinshi, you know how it goes: the good ones end up scattered across
a dozen gallery sites, in bookmarks you never scroll back through, or in a pile of
open tabs on your phone. Every site tags things its own way, titles come in three
languages, and the one you wanted to reread last month has long dropped out of
your history.

I built nhdb so that stops happening. Paste a link from (almost) any gallery site —
or a whole dump of tabs at once — and nhdb reads the page, pulls out the title,
artists, groups, parodies, characters and tags, and files it in your own catalogue.
From there you can filter by any mix of tags, sort by when you added, read or
uploaded something, by pages or by how often you come back to it, give titles names
you will actually remember, and see what your reading habits look like.

### What it does

- **Works with any site, no plugins.** There is no list of supported sites. nhdb
  reads the conventions gallery engines share (headings, tag and artist links,
  labelled rows, the usual doujin title format) and politely refuses anything that
  isn't a single title: search pages, tag listings, 404s, login walls.
- **One vocabulary across sites.** "Big Breasts" on one site and
  "female:big breasts" on another become the same tag, so filters and statistics
  work no matter where a title came from.
- **Helps you find things again.** *Related tags* widen a search with tags that
  genuinely characterise what you selected. *Ghost tags* guess which tags a
  sparsely tagged title is probably missing, from the artist's other works — shown
  as dashed outlines, off by default, never saved as real tags.
- **Reading statistics.** What you read, when (by hour and by day of the week),
  and what you keep coming back to.
- **Adding from your phone.** Share a page straight to nhdb's quick-add link, or
  queue a batch with a `?add=` link — handy as a bookmarklet or a phone shortcut.
- **Swipe mode.** Go through the titles you haven't named yet one cover at a
  time: name the keepers, mark the rest for deletion.
- **Your data stays yours.** Export your whole collection as JSON, or delete your
  account and everything in it in one go.

### Why you bring your own scraper

nhdb stores metadata and links only — never the pages or images themselves
(covers are fetched on demand through a proxy). Reading the pages is done by a small
scraper that **you** run: on your own computer behind an ngrok tunnel, or on your own
server. Gallery sites sit behind Cloudflare and rate limits, and one shared scraper
would funnel everybody's browsing through a single address, so every account brings
its own and registers it on the Account page. Setting one up takes a few minutes —
see [Scraper](#scraper).

### Using it

The hosted version lives at **https://nhdb.vercel.app**: sign up with an email,
verify it, register your scraper under *Account*, and start adding. It is a hobby
project running on free tiers, so there are fair-use limits (5,000 titles per
account, caps on scraping and cover traffic) that keep one heavy user from
taking it down for everyone. If you would rather keep everything to yourself, run
your own instance — the rest of this README explains how.

**18+ only.** nhdb catalogues adult content. It is meant for adults, and it never
hosts or redistributes the works themselves.

Built with Next.js 16, React 19, Prisma 7, Neon Postgres and Neon Auth, deployed on
Vercel. MIT licensed.

## Local setup

1. Copy `.env.example` to `.env` and fill in the database and Neon Auth values.
   Enable email/password sign-in and email verification in Neon Auth. The verify
   screen accepts both methods: a numeric code (the only one Neon's shared email
   provider can send) or a link (needs a custom email provider). The Auth
   endpoint and database must belong to the same Neon branch; allow localhost
   and your deployed origin in Auth's trusted domains.
2. Run `pnpm install --frozen-lockfile` (also generates the Prisma client).
3. Apply migrations to your intended development database with `pnpm db:deploy`.
4. Run `pnpm dev` and open http://localhost:3000. Create an account, verify your
   email, then sign in.

Each account has its own titles, tags, reading history, cache and browser scrape
queue. Server actions and API handlers derive the owner from the authenticated
session; the browser cannot select another collection.

## Sources

Titles can come from **any gallery site**. Paste gallery links into the add box
(a whole tab dump is fine), share one to `/add/<link>`, or queue several with
`/?add=<links>`; a bare number still means an nhentai id. There is no list of
sites: a link counts when its address looks like one title's, and the scraper
reads the page from conventions gallery engines share (headings, tag/artist
links, labeled rows, the doujin title convention) and refuses pages that are
not a title — search, tag and listing pages, 404s, login walls. Tags, artists,
groups, parodies and characters from every site are folded into one lowercase
vocabulary, so filters, stats, related tags and ghost tags work across sites.
See `SCRAPER.md` for how a page is read.

## Scraper

The database is shared; the scraper is not. Every account runs its own and
registers it under **Account** (top right → `/account`):

1. Set `SCRAPER_SECRET`, install/configure ngrok, and start `pnpm scraper` on
   your own machine; it opens a public HTTPS tunnel. Or deploy your own service
   on Render using `render.yaml` — see [SCRAPER.md](SCRAPER.md).
2. Add its URL as the **primary** host, plus its `SCRAPER_SECRET`.
3. Add **fallbacks** (up to eight hosts total); they are tried in order, top to bottom,
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
Neon Auth** (not your email; signed in, `/api/auth/get-session` shows it as
`user.id`), before adding titles to the account:

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
be deployed together because the old client uses single-user keys; the same goes
for migration 9 (title sources), since the new code writes `source`/`source_id`.
Migration 9a (any-site titles) only widens and relaxes, so the previous app
version keeps working against it; it may be applied before the code ships.
Scraper hosts should be updated too — an older host still serves nhentai, but
answers other sites' links with an error the app reports as "older version".

## Collection tools

On `/account`, download your collection and reading history as JSON (20 exports
per UTC day), or permanently delete your data by typing `DELETE`. Deletion also
requests removal of your Neon Auth login and signs you out. If the auth service
cannot remove it, the result explicitly says your login remains; contact the
operator. Quota counters keep their normal windows so deletion cannot reset limits.

Exports stream in batches and exclude additions after their captured start time
and maximum keys. They are not transactional snapshots: avoid editing your
collection until the download finishes, and retry if it is interrupted.

New accounts have no scraper hosts. Register your own under `/account` before
adding titles; production returns a setup error until a host is available. The
`SCRAPER_SERVICE_URL*` environment variables are a development convenience only.

## Command-line collection tools

For `pnpm rescrape`, set `NHDB_SESSION_COOKIE` to the Cookie header from a
signed-in browser request. The command resolves the verified account from that
session and only reads/re-scrapes its collection. `--all`, `--list`, and
`--limit=N` are supported. `APP_URL` defaults to http://localhost:3000.

To audit IDs saved under older URL rules without changing data:

```sh
pnpm audit:ids --from-json=export.json
pnpm audit:ids --database --since=2026-10-05
```

The JSON snapshot is an array with `user_id`, `hashtag`, `source`, `source_id`,
`url`, `title_name` and `created_at`. Offline mode does not load environment
files or contact the app/database. Database mode requires the same verified
`NHDB_SESSION_COOKIE`, `APP_URL` and `DATABASE_URL` as rescrape, reads only that
account's collection, and uses a read-only transaction. The cutoff is inclusive
and interpreted in UTC (default: 2026-10-05). Older rows are read to detect
collisions. The JSON report lists ID mismatches, their current source/ID and
colliding hashtags within the same account; missing/unrecognised URLs appear
separately. There is no repair mode and no scraping. Rows already overwritten
by an old ID collision cannot be recovered by this audit.
