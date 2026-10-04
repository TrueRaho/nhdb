# Security model

The app is multi-user. Every row in the collection is owned by exactly one Neon
Auth user, and the whole security model is two independent layers saying the
same thing: the application never queries without an owner, and the database
cannot store a row that mixes two owners.

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

## Legacy data: `nhdb:unclaimed`

Migration 6 parks the pre-multi-user rows under the sentinel owner
`nhdb:unclaimed`. No one can sign in as that sentinel, so the data is
inaccessible until `pnpm claim <neon-auth-user-id>` transfers it. The claim
takes a table lock, defers the composite foreign keys for the rename, and
**refuses to run if the target account already has a collection**, so it can
never merge two libraries or overwrite one.

## What can be stored: titles, and only titles

Titles come from seven sites (nhentai, E-Hentai, Hitomi, HentaiFox, IMHentai,
Pururin, Hentai2Read). Anything a user types or pastes is untrusted, and so is
anything their scraper host answers, so there are three gates — each refuses on
its own, and none trusts the one before it:

1. **Input is an allow-list of gallery pages** (`lib/sources.ts`). A link is
   accepted only if it matches one site's *title* page pattern (`/g/<id>/`,
   `/gallery/<id>/`, `/galleries/<id>.html`, a Hentai2Read slug that is not one
   of the site's own sections…). Search pages, tag pages, home pages and links
   to any other host match nothing and are dropped — in the paste box, in
   `?add=`, in `/add/<link>`, in `/api/scrape` (a `400` before the scrape budget
   is charged or any host is contacted) and again on the scraper host.
2. **The fetched address is rebuilt from the id**, never taken from the input.
   The pasted URL — its host, path, query string — is gone after step 1; the
   scraper fetches `SOURCES[site].url(id)` (or the site's metadata API) and
   nothing else. A response that redirects to another host is not read
   (`fetchHosts` per adapter), and a page without a title's markup is refused
   as "not a title" rather than stored.
3. **The write boundary re-derives the payload** (`lib/scrape-payload.ts`),
   because a commit's payload comes back from the browser and a host's answer
   comes from a machine the user controls. Unknown keys are dropped; the source
   must be a known site and the id its canonical form; the cover must be https
   on that site's own image hosts (the same list `next.config.ts` lets the image
   optimizer fetch, kept in step by a test); every entity link must be https on
   the site itself; every string fits its column; entity counts are bounded.
   `/api/scrape` runs the same check on a host's answer before passing it on,
   and refuses an answer about a different title than the one asked for.

In the database, `titles_source_hashtag_check` keeps the key ranges apart
(an nhentai row's hashtag is its id, below 1e9; nothing else may sit there) and
`(user_id, source, source_id)` is unique. The list of sites is deliberately an
application allow-list, not a database constraint.

## Per-user scraper hosts

The database is shared; the scraper is not. Each user registers their own hosts
on `/account`, in priority order, and the app tries them in turn. Nothing falls
back to someone else's machine — in production the `SCRAPER_SERVICE_URL` env
vars are ignored entirely, and an account with nothing configured gets a `409`
telling it to go to settings.

This makes the deployment fetch a **user-supplied URL**, which is a request
forgery primitive by construction. `lib/net-guard.ts` is the whole defence:

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
- **Checked again immediately before connecting**, not only when saved — a name
  that resolved publicly at save time can resolve to `127.0.0.1` later.
- **Redirects are refused** (`redirect: "error"`). The address checks apply to
  the URL we chose; a `302` would send the next request, bearer token attached,
  somewhere nobody validated.

Residual risk: a DNS answer can still change between the check and the socket
connecting. Closing that fully means pinning the resolved address and connecting
to it with an explicit `Host` header, which `fetch` does not expose.

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
refuses to start. Local-only runs without a secret need `DISABLE_NGROK=1`.

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

## Scrape budget

Sign-up is open and every account shares **one** scraper, where a browser
fallback costs a 15–30 s Playwright page. `lib/rate-limit.ts` caps each user at
`SCRAPE_LIMIT` (120) scrapes per hour and returns `429` with `Retry-After`.

Two details that are the point of it:

- **It is counted in Postgres, not in memory.** On Vercel, process memory is per
  lambda instance, so an in-memory bucket hands N times the limit to a caller who
  can make the platform spin up N instances.
- **It is charged only by the paths that reach the scraper.** Committing an
  already-scraped payload writes the caller's own rows and spends nothing, and a
  request rejected as malformed spends nothing either.

The charge is a single atomic upsert whose `WHERE` refuses on the conflict path,
so concurrent scrapes from one account cannot lose updates (the batch pool fires
four at a time by design) and a throttled caller cannot push their own reset
further out by retrying.

The client-side pool cap (`MAX_CONCURRENT_SCRAPES = 4`) is per tab and is about
politeness to the tunnel, not abuse. It is not a throttle.

## Known gaps

- **No explicit Origin check on `POST /api/scrape`.** Route Handlers get none
  from Next.js, unlike Server Actions. Session cookies are `SameSite=Lax`, so a
  cross-site POST does not carry them and browsers block the attack today; an
  explicit check would be defence in depth rather than a fix.
