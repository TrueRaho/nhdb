# Security model

The app is multi-user. Every row in the collection is owned by exactly one Neon
Auth user, and the whole security model is two independent layers saying the
same thing: the application never queries without an owner, and the database
cannot store a row that mixes two owners.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open this repository's **Security →
Advisories → Report a vulnerability**. Include reproduction steps, the affected
version and the expected impact. Keep vulnerability details in the private
report while a fix is being coordinated.

## App access: Neon Managed Better Auth

Authentication is **in the application**, not at the platform edge. Vercel
Deployment Protection must be **off for Production** — it gates on membership of
the Vercel team, which is exactly the wrong question once other people have
accounts. (Leaving it on for Preview is fine and changes no code.)

Identity comes from Neon Managed Better Auth (`@neondatabase/auth`), whose users
and sessions live in the `neon_auth` schema of the same database — so a Neon
branch carries its own isolated user set.

### The two checks, and why there are two

`proxy.ts` is the **optimistic** layer: it turns unauthenticated navigations
around before a page renders. It is deliberately not trusted for authorization —
a matcher is a configuration file, and Next.js routes Server Actions as POSTs to
*the page that uses them*, so a matcher change can silently drop coverage.

`/design-preview/*` contains development harnesses. Its shared Server Component
layout calls `notFound()` in production, including for signed-in users; the
proxy's bypass keeps them usable without login in `pnpm dev` only.

`lib/session.ts` is the **real** gate, and the only place a `userId` is ever
produced:

| helper | refuses by | used from |
| --- | --- | --- |
| `requireUserId()` | throwing `UnauthorizedError` | Server Actions, Route Handlers |
| `requireUserIdOrRedirect()` | redirecting to sign-in | Server Components |
| `getUserId()` | returning `null` | "is anyone signed in?" branches |

Every one of the Server Actions in `app/actions.ts` calls
`requireUserId()` **before touching data**, and `POST /api/scrape` returns 401
without a session (and 503, not 200, if the Auth service itself is unreachable —
it fails closed). `app/actions.test.ts` pins this for every one of them.

A `userId` is **never accepted from the client**. A forged `userId` inside a
query payload is ignored because the action overwrites it with the session's —
`app/actions.test.ts` pins that too.

### Email verification

`requireUserId()` rejects a session whose `emailVerified` is not exactly `true`.
Sign-up is open, so this is what stops an unverified address from creating a
collection. **It couples to a console setting**: Neon → Settings → Auth →
*Sign-up with Email* + *Verify at Sign-up* must stay enabled. If that toggle is
ever turned off, Better Auth keeps issuing sessions with `emailVerified: false`
and every user is locked out. That is the intended direction to fail, but it is
a coupling worth knowing before flipping the switch.

## Data isolation

**In the application.** Every read and write in `lib/titles.ts` takes `userId`
as its first argument and `assertUserId()` rejects an empty one — because Prisma
drops `undefined` filters, a missing identity would otherwise widen a query
instead of failing it. `buildWhere` puts `userId` at the **top level** of the
filter, so it AND-combines with every other clause; no ghost-tag or expansion
`OR` branch can reach past it.

**In the cache.** `"use cache"` keys an entry on its arguments, so passing
`userId` is what isolates one user's cached rows from another's. Tags
(`lib/cache-tags.ts`) are scoped per user as well — not for isolation, which the
key already provides, but so one person's write does not throw away everyone
else's cached pages.

**In the database.** Migration `6_multi_user` makes a cross-tenant row
*unrepresentable* rather than merely unwritten:

- `titles` is keyed `(user_id, hashtag)` — two people legitimately own the same
  gallery. (For nhentai the hashtag is the gallery id; titles from the other
  sites get a key ≥ 1e9 — see "What can be stored" below.)
- The five entity tables are per-user, with `UNIQUE (user_id, name)`.
- Every join row carries `user_id` and proves it **twice**, with composite
  foreign keys to both the title *and* the entity.

That last point is the one that does not depend on application code being right.
Verified against the live database: inserting a link between one user's title
and another user's tag is rejected by `titlestotags_tag_fkey`.

Per-collection statistics stay per-collection for the same reason —
`tags.title_count`, `titles.avg_tag_value`, tag affinity and ghost tags are all
fractions *of the collection*, and every entity id already belongs to one user.

## Account deletion and collection export

`/account` requires typing `DELETE` before its Server Action deletes the caller’s
data. The action derives the owner from the verified session, takes the user
write lock, sweeps pre-existing unlinked entities, and deletes all their titles,
read logs and scraper endpoints in one transaction. Title joins cascade; the
deferred triggers remove newly orphaned entities at commit. Other users and deployment-wide budget rows are preserved.
Every caller cache tag, including each deleted title, expires with `updateTag`.
Quota counters are kept until their window ends so deletion cannot reset limits.

After commit, the action calls the supported `auth.deleteUser({})` method in
`@neondatabase/auth` **0.5.0-beta**, followed by `auth.signOut()`. It claims login
deletion only for `{success: true, message: "User deleted"}`. A disabled endpoint,
stale session, verification-email response or outage is not proof of deletion:
the UI says **“your login remains; contact the operator”**. Data is still deleted.
The UI always navigates out of the retained app state; this browser’s Neon Auth
cookies are also explicitly expired if remote sign-out fails. In that failure
case, revocation of remote sessions is unconfirmed. Auth deletion is a separate
service call after the data transaction; the two cannot be atomic. Existing
requests or sessions on other devices may still act while deletion is in flight
or when login deletion fails; the operator must remove the remaining login.

`GET /api/export` checks the verified session and charges the caller’s `export`
usage counter, limited to **20 exports per UTC day**, before reading data. Titles,
all five entity kinds and read logs use owner filters. After the budget charge,
the export captures its start time and the caller's maximum title hashtag and
read-log ID. It streams JSON in keyset batches of **250 titles** (by hashtag)
and **1000 read logs** (by read time, then ID), serializing one record per chunk.
No interactive transaction stays open during the download. Exported titles have
`created_at <= start` and `hashtag <= captured max`; logs must have
`read_at <= start` and `id <= captured max`. These bounds exclude later additions,
including lower-numbered titles and backdated logs; this is not a transactional
snapshot. Concurrent edits may be reflected and deletions may omit records.
For a stable copy, avoid changing the collection until the download finishes.
A failed batch aborts the download; retry rather than use a partial file.
The response is a private, non-cacheable JSON attachment with explicit selected
fields; scraper endpoints, bearer tokens, encrypted credentials, auth records
and budgets are never exported. Quota denial returns 429 + Retry-After before
streaming; an interrupted download still spends its admitted export attempt.

## Legacy data: `nhdb:unclaimed`

Migration 6 parks the pre-multi-user rows under the sentinel owner
`nhdb:unclaimed`. No one can sign in as that sentinel, so the data is
inaccessible until `pnpm claim <neon-auth-user-id>` transfers it. The claim
takes a table lock, defers the composite foreign keys for the rename, and
**refuses to run if the target account already has a collection**, so it can
never merge two libraries or overwrite one.

## What can be stored: titles, from any site

Titles can come from any gallery site — there is no list of sites (there was
one, of seven, until migration 9a). Anything a user types or pastes is
untrusted, and so is anything their scraper host answers, so there are three
gates — each refuses on its own, and none trusts the one before it:

1. **The input must look like one title's address** (`lib/sources.ts`): a web
   address (http(s), a DNS name — never an IP literal — no credentials, the
   scheme's own port) in which `galleryIdOf` finds a gallery id. Home, search,
   tag, artist and listing pages are refused — in the paste box, in `?add=`, in
   `/add/<link>`, in `/api/scrape` (a `400` before the scrape budget is charged
   or any host is contacted) and again on the scraper host.
2. **The page must read as a title** (`lib/scrapers/extract.ts`). A page that
   does not say enough to be one — a listing, a 404, a login wall, a news
   article — is refused as `NOT_FOUND` rather than stored. A redirect to
   another site or to another title's id is not read. Every address the
   scraper fetches, including links it follows (a content warning's "View
   Gallery") and every hop of a server redirect, must resolve to public
   addresses only (`lib/net-address.ts`). Followed links stay on the title's
   site and are capped at two. The fast layer (impit) is asked not to follow
   redirects (`redirect: "manual"`) and the scraper follows them itself, at
   most five, checking each Location before it is requested — left to impit,
   a `302 Location: http://127.0.0.1:…` was requested before anything looked
   at it. Both impit (`proxyUrl`, HTTP/3 disabled) and Chromium send HTTP(S)
   traffic through loopback proxies (`lib/scraper-proxy.ts`): absolute-form
   HTTP and CONNECT on web ports,
   all DNS answers must be public before connecting, and the connection uses
   the checked IP without another lookup. Loopback bypass is disabled, so
   redirects also pass through the gate. HTTPS stays end-to-end (Host/SNI are
   preserved, with certificate verification left enabled). The proxy is kept
   with its client and closed on shutdown or idle expiry. The browser may
   contact another public site during a redirect; the final page still has to
   belong to the requested site/title to be read.
3. **The write boundary re-derives the payload** (`lib/scrape-payload.ts`),
   because a commit's payload comes back from the browser and a host's answer
   comes from a machine the user controls. Unknown keys are dropped; the source
   must be a host name (or a legacy key) and the stored `url` a web address on
   that site whose gallery id IS the payload's id, so one title's data cannot be
   filed under another's; the cover must be a web address; an entity link that
   leaves the title's site is dropped (the entity is kept); every string fits
   its column; entity counts are bounded. `/api/scrape` runs the same check on a
   host's answer before passing it on, and refuses an answer about a different
   title than the one asked for.

In the database, `titles_source_hashtag_check` keeps the key ranges apart
(an nhentai row's hashtag is its id, below 1e9; nothing else may sit there),
`(user_id, source, source_id)` is unique, and `titles_source_format_check` /
`titles_url_check` are backstops for the format. Seven sites keep the short
keys their rows were saved under before 9a (`lib/sources.ts` LEGACY) — a naming
table for old rows, not a gate.

What this no longer stops: a user storing titles from a site nobody else would
call a gallery. That is their collection; the gates exist so that what is
stored is a title-shaped record of a real page, and that fetching it cannot be
turned against the deployment.

## Covers: `/api/cover`

Covers are not loaded from the sites' CDNs by the browser. Some CDNs serve an
image only to a request carrying the gallery's own site as `Referer` (Hitomi's
thumbnail host does; any of them may start), and a page on this origin cannot
send one — nor can the Next image optimizer, which forwards no headers. So every
cover `<img>` points at the same-origin proxy (`lib/sources.ts` `coverSrc`:
`/api/cover?src=<cover>&ref=<title page origin>`), which fetches the cover with
that origin as `Referer` (`lib/cover-proxy.ts`). The image optimizer is off and
has no `remotePatterns`, so it is not a second way to fetch anything.

The URL arrives from the browser and covers live on any CDN, so this is a
server-side fetch of arbitrary client input. There is no host list behind it;
these rules are the whole defence, and each matters on its own:

- **A web address only** (`parseWebUrl`): http(s), a DNS name (no IP literal),
  no credentials, the scheme's own port — nothing but a web server's 80/443 is
  ever dialled.
- **Public addresses only**, checked before every hop with
  `assertPublicHostname` and again at the socket boundary by the undici Agent
  in `lib/public-fetch.ts`. Its lookup returns only the checked IPs, with no
  second resolution before connecting. A name can resolve anywhere, including
  `169.254.169.254`, and every resolved address must be public. Host/SNI and TLS
  certificate verification stay with the standard connector.
- **Redirects by hand** (`redirect: "manual"`), at most three, each hop
  re-checked the same way.
- **Only an image comes back.** The type is sniffed from the bytes (JPEG, PNG,
  GIF, WebP, AVIF) and set by the proxy, never echoed from upstream, so an SVG or
  HTML answer cannot run on this origin and no JSON/HTML answer from anything is
  relayed; the body is capped at 1 MiB.
  Responses carry `nosniff`, a `sandbox` CSP and
  `Cross-Origin-Resource-Policy: same-origin`, so other sites cannot embed the
  proxy.
- **Signed-in users only**, or the deployment would be a public Referer-spoofing
  image fetcher. Answers are cached `private` (browser only), so no shared cache
  serves them past the check.
- **Request budgets before fetching:** 10,000 requests per user per UTC day and
  500,000 across the deployment per UTC month. Both conditional upserts run in
  one transaction; a denial increments neither and returns an uncached `429`
  with `Retry-After`, without fetching upstream. This leaves room for two full
  5000-title gallery passes/day and caps admitted cover requests at half the
  launch target's monthly invocation allowance. Failed fetches and byte-precheck
  denials consume requests too. Counter errors return `503` before fetching.
- **Byte budgets in Postgres:** a read-only pre-check rejects already-exhausted
  current user/global counters before fetching. After-fetch charges remain the
  authoritative protection against concurrent requests. Successful image bytes consume at most
  3 GiB per user and 4 GB across the deployment per UTC calendar month. Both
  single-statement conditional upserts run in one transaction: a denial rolls
  back both charges and returns an uncached `429` with `Retry-After`. Counter
  failures return `503`, never an unmetered image. Failed upstream fetches spend
  no bytes. Successful responses are browser-cached `immutable` for 30 days, so
  scrolling a collection again normally spends nothing. 3 GiB covers 3072 images
  at the full 1 MiB cap, or 5000 averaging 629 KiB; typical thumbnails are smaller.
  The 4 GB ceiling leaves headroom under the launch target's 10 GB/month Fast
  Origin Transfer allowance, including other routes and error responses. It
  meters this route's image bodies, not the platform's entire transfer bill.
  `NhCover` falls back to procedural art on a failed load, including `429`.

## Per-user scraper hosts

The database is shared; the scraper is not. Each user registers their own hosts
on `/account`, in priority order, and the app tries them in turn. Nothing falls
back to someone else's machine — in production the `SCRAPER_SERVICE_URL` env
vars are ignored entirely, and an account with nothing configured gets a `409`
telling it to go to settings.

This makes the deployment fetch a **user-supplied URL**, which is a request
forgery primitive by construction. `lib/net-guard.ts` and the connection gate in
`lib/public-fetch.ts` enforce these rules:

- **https only**, with one exception: plain `http` to a loopback host outside
  production, which is the local `pnpm scraper` case. In production loopback *is*
  the deployment, so that exemption would be the hole it looks like.
- **No credentials, query string or fragment** in the stored URL.
- **Every resolved address must be public.** Loopback, RFC1918, carrier-grade
  NAT, link-local (including the `169.254.169.254` metadata endpoint),
  multicast and reserved ranges are refused, for IPv4 and IPv6. IPv4-mapped and
  NAT64-embedded IPv6 addresses are unwrapped and judged as the IPv4 address they
  carry, or `::ffff:169.254.169.254` would walk straight past an IPv4-only list.
- **All** answers must pass, not the first: one public and one private record is
  a rebinding attempt, not a misconfiguration.
- **Pinned at connection time** by the undici Agent in `lib/public-fetch.ts`,
  not only checked when saved. Its socket lookup validates every answer and
  hands those IPs directly to the connector, without another resolution. IP
  literals are checked too. Host/SNI and TLS certificate verification stay
  unchanged. The dev-only `http://localhost` exception pins to `127.0.0.1`.
- **Redirects are refused** (`redirect: "error"`). The address checks apply to
  the URL we chose; a `302` would send the next request, bearer token attached,
  somewhere nobody validated.

Host responses are read through `lib/read-capped.ts` with a **2 MiB cap on the
decompressed stream**, for every status (gzip/br Content-Length is not a size
guarantee). Overflow cancels the stream and becomes a small `502`. Host bodies
are never relayed verbatim: successful titles are re-derived at the payload
boundary, errors contain only a 500-character message, an optional 64-character
code and the recognized `reads: "any-site"` capability.

One absolute **50-second outbound deadline**, measured from route entry,
includes DNS, connecting and reading the body across all hosts. Each attempt
gets at most 12 seconds (45 for the last host), further reduced to the remaining
allowance; an expired deadline returns the last error without contacting more
hosts. This leaves headroom under `maxDuration = 60` for validation/persistence;
it does not cancel an already-running authentication or database operation.

### Scraper secrets at rest

Each host's bearer token is stored AES-256-GCM encrypted (`lib/secret-box.ts`)
under `SCRAPER_CRED_KEY`, never in plaintext — several people's service
credentials now share one table, and a database dump must not hand them over.
GCM specifically, because the value is read back into an `Authorization` header:
a malleable ciphertext would let anyone with write access to the row steer that
header, whereas a tampered one fails to decrypt.

A secret is **never sent to the browser**. The settings screen receives only
`hasSecret`, and an unchanged field sends back "leave it alone" rather than the
value. A kept secret is carried over by **URL**, so reordering hosts preserves
it while repointing a row at a different machine correctly requires re-entering
it.

If a stored secret will not decrypt (key rotated, row tampered with) the host is
**dropped**, not called without a credential. Silently downgrading a
credentialed call to an anonymous one is how a key rotation becomes an incident.

## Shared scraper service: `SCRAPER_SECRET`

`scripts/scraper-server.ts` is what each user runs on their own machine. It is a
**separate deployment** that app-level auth does not cover, protected by the
`SCRAPER_SECRET` bearer token it is started with: the `/api/scrape` route sends
`Authorization: Bearer <that host's secret>`, and the scraper server verifies it
with a constant-time compare (`timingSafeEqual`). The value each user types into
`/account` must match the one their own scraper runs with — there is no longer a
single global secret.

It is a **service** credential, not a user credential: the scraper never learns
who asked, touches no database, and must stay that way. Holding it does not
make the host a general-purpose fetcher either: the host accepts only title
links from the supported sites and fetches the address it rebuilds from the id
(see "What can be stored" above).

The server **fails closed**: if `SCRAPER_SECRET` is unset while the process
would be publicly reachable (on Render, or with the ngrok tunnel enabled), it
refuses to start. Local-only runs without a secret need `DISABLE_NGROK=1` and
bind to **127.0.0.1 only**, so the LAN cannot use them. With a secret the server
continues to bind `0.0.0.0` for Render/ngrok.

## Automation: `pnpm rescrape`

The script authenticates as a real signed-in user rather than holding a
privileged credential: set `NHDB_SESSION_COOKIE` to a signed-in browser `Cookie`
header. It resolves the session through `/api/auth/get-session`, requires it to
be verified, and scopes both its database query and its writes to **that** user.
There is deliberately no admin token and no way to name a target user — such a
parameter would be an escalation path reachable from the browser if it ever
leaked into the route.

`VERCEL_AUTOMATION_BYPASS_SECRET` is still needed when `APP_URL` points at a
deployment with Preview protection enabled.

## Usage budgets

Sign-up is open; the database and deployment are shared, while scraper hosts
belong to each user. A browser fallback costs a 15–30 s Playwright page.
`lib/rate-limit.ts` caps each user at
`SCRAPE_LIMIT` (120) scrapes per hour and returns `429` with `Retry-After`.

Two details that are the point of it:

- **It is counted in Postgres, not in memory.** On Vercel, process memory is per
  lambda instance, so an in-memory bucket hands N times the limit to a caller who
  can make the platform spin up N instances.
- **It is charged only by the paths that reach the scraper.** Committing an
  already-scraped payload spends no scrape budget; creating a new title spends
  the separate commit budget below. A malformed request spends nothing.

The charge is a single atomic upsert whose `WHERE` refuses on the conflict path,
so concurrent scrapes from one account cannot lose updates (the batch pool fires
four at a time by design) and a throttled caller cannot push their own reset
further out by retrying.

The client-side pool cap (`MAX_CONCURRENT_SCRAPES = 4`) is per tab and is about
politeness to the tunnel, not abuse. It is not a throttle.

`upsertScrapedTitle` enforces **5000 titles/user** and **240 new titles/hour**
(UTC calendar hours) for both `/api/scrape` persist paths and the Server Action.
It locks that user's writes in the transaction before the conditional title
insert/count. Existing identities bypass the title cap and spend no commit
budget, so re-scrapes still work at or above either limit. Only a newly inserted
row charges the commit budget, before entity upserts; any failure rolls back
the title, entities, links and charge together. The payload gate allows at most
**64 entities/kind** (the unchanged corpus peaks at 24 tags, 3 other entities).
The route returns `429` with `Retry-After`; the Server Action returns an explicit
error value that quick add and batch jobs display, preserving unsaved jobs.
Deleting a title frees its slot but never refunds a commit.

`markRead` takes the same user lock and conditionally updates the title only if
its last read is at least **10 minutes** old. Duplicates add no log, increment
no counter and spend no budget. New logs consume at most **500/user/UTC day**;
a refusal rolls back the title update and appends no log. These counters and
cover byte budgets use `usage_budget` (expand-only migration `9b`); each counter
resets its existing row, so windows do not accumulate storage. The original
`scrape_budget` primary key is unchanged.

## Known gaps

- **The browser gateway covers HTTP(S), not every browser protocol.** Chromium
  launches with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` to
  disable WebRTC UDP outside the proxy (checked with a local STUN listener).
  Other non-HTTP protocols are outside this gateway; the proxy and launch flags
  are not a process/network sandbox.

- **A signed-in user can fetch any public image through `/api/cover`**, with any
  Referer they name. Titles come from any site, so there is no list of image
  hosts to restrict it to; what it can reach is public web servers on 80/443
  answering with an image of at most 1 MiB. This run meters response bytes per
  user and globally (above); it does not bind URLs to stored titles or add HMAC
  signatures. Already-exhausted byte counters and request limits stop upstream
  fetches. Denied HTTP requests still invoke the handler and do authentication/
  budget checks; app-level counters cannot prevent those platform invocations.
  The byte ceiling covers successful image responses, while request budgets
  also bound admitted upstream fetches of tiny or unsuccessful images.

- **No explicit Origin check on `POST /api/scrape`.** Route Handlers get none
  from Next.js, unlike Server Actions. Session cookies are `SameSite=Lax`, so a
  cross-site POST does not carry them and browsers block the attack today; an
  explicit check would be defence in depth rather than a fix.
