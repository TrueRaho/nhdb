# Scraper service

The scraper runs outside Vercel because the browser fallback needs a real
Chromium, which Vercel's serverless runtime can't host comfortably. Vercel's
`/api/scrape` proxies to it when `SCRAPER_SERVICE_URL` is set.

## Which sites

Any gallery site. There is no list of sites and no per-site code: the scraper
reads a page the way a person skims one, from conventions gallery engines
share. Two steps:

1. **The address** (`lib/sources.ts`). A link counts when it looks like ONE
   title's: a gallery word followed by an id (`/g/177013`, `/gallery/42/`,
   `/view/1200000/3/`, `/galleries/1234567.html`, `/manga/<slug>/`), an
   `?id=` query, a long number, a slug ending in one, or a lone slug. Home,
   search, tag, artist and listing pages (`/tag/…`, `/search?…`, `/`) are
   refused with `400 BAD_INPUT` before anything is fetched. The id found here
   is the title's identity on its site; the site is the host name.
2. **The page** (`lib/scrapers/extract.ts` `readPage`). It decides whether the
   page is a title and reads it:
   - **title** — the `<h1>` that the document's own `<title>`/`og:title` names
     (a page's other `<h1>`s are buttons, logos, related titles), else
     schema.org `name`, else `og:title` without the site's name;
   - **the info block** — the nearest block around the title that holds
     entity links; sidebars, "related"/"more like this", comments, menus,
     tag clouds and pagination are noise and never read;
   - **entities** — what a link is comes from three signals, strongest first:
     a namespace in its value (`female:big breasts`, `artist:foo`, `Series: x`),
     the label of its row (`Artists:`, `Parodies`, a table's first cell), and
     the words of its path (`/tag/x`, `/artist/x`, `/series/x`, `/circle/x`,
     `/character/x`). Count badges are stripped, `a | b` aliases split,
     `English / 日本語` names take the first half, `Series dj.` is the series,
     languages and pure publication words (doujinshi, manga, hentai, artist cg…)
     are skipped. Genre-like words (webtoon, mature, smut…) remain tags with an
     explicit Tags/namespace signal, while Category/Type and ambiguous
     Genre/Content taxonomies treat them as formats;
   - **the title convention** — `(Event) [Circle (Artist)] Title (Parody)
     [English]` names the circle, artist and parody, used when the page lists
     none of them;
   - **page count and date** — labeled rows (`Pages: 24`, `Length: 20 pages`,
     `Posted: 2013-08-10`), `<time datetime>`, an element classed `date`, JSON-LD,
     and reader links `/…/<id>/<n>/` for the count;
   - **cover** — an image marked as one (`cover` in its class/id or a parent's),
     a CSS `background: url(…)`, `og:image`, with lazy-load attributes
     (`data-src`, `srcset`) read before a placeholder `src`.

   A page that does not say enough to be a title is refused (`NOT_FOUND`): a
   listing (it links to many other titles), a 404 or "removed" page, a login
   wall, a news article with tags and an image but nothing else. A content
   warning or age gate answers "follow" with its "View Gallery"/"Continue"
   link, and a reader page with its link back to the gallery — at most two
   hops, on the same site.

What the scraper guarantees, whatever the site:

- **One vocabulary.** Entity names are folded to lowercase, whitespace-collapsed
  NFKC (`Big Breasts` → `big breasts`); namespaces and ♀/♂ flags are dropped
  from the name. That is what makes a tag filter, related tags and ghost tags
  see one "big breasts" across sites.
- **Nothing invented.** A date that is not on the page, or only relative
  ("3 days ago", "Release Year: 2019"), stores `null`; a page count that is not
  on the page stays `0`.
- **Self-checked.** The reading goes through the validator the app's write
  boundary uses (`lib/scrape-payload.ts`), so a misread fails at the scraper,
  with the reason, instead of as a 400 on save.
- **Same title only.** A redirect to another site, or to another id on the same
  site (IMHentai answers a replaced gallery with a 301 to its successor), is not
  read: the user is told which title it now redirects to.
- **Public addresses only.** Every address — the pasted one, every followed
  link and every redirect hop — must resolve to public IPs
  (`lib/net-address.ts`) before it is fetched, so the scraper host cannot be
  pointed at its own network. impit therefore runs with `redirect: "manual"`
  and the scraper follows Location headers itself (at most five), each one
  checked first. Chromium sends HTTP(S), including redirect hops, through a
  temporary loopback HTTP/CONNECT proxy (`lib/scraper-proxy.ts`). It checks all
  DNS answers, connects to the checked IP, and accepts only web ports; loopback
  bypass is disabled. HTTPS remains end-to-end. The proxy closes with the warm
  browser, including launch/setup failures and crashes.

Titles keep their bracketed lead/tail out of the name the way nhentai's
`.pretty` title does: `(C92) [Circle (Artist)] Title (Parody) [English]` is
stored as `Title` — the brackets are already the title's entities.

**Verification status.** Heuristics are measured, not assumed: the fixture
corpus in `lib/scrapers/fixtures/` (one `<id>.html` + `<id>.json` expectation per
page — nhentai and two mirrors, E-Hentai incl. its content warning, Hitomi
rendered and unrendered, the HentaiFox/IMHentai engine, Pururin, Hentai2Read,
3hentai, asmhentai, HentaiHere, Luscious, WordPress/Madara and Drupal sites,
and negative pages: listings, searches, tag pages, 404s, login walls, a news
article) is run by `lib/scrapers/corpus.test.ts`. The pages were reconstructed
from how those sites are built, not downloaded (the build machine cannot reach
them), so a live page can still differ. When a site reads wrong: save its HTML
as a new fixture with the expectation you want, and make the generic rule that
fixes it pass without breaking the others — never add a site-specific branch.

**Known limit: profiles at a bare-slug address.** Artist, tag and series pages
under `/artist/…`, `/tag/…`, `/series/…` are refused by the address alone. A
profile served at a single-slug address (`/some-fandom/`) has to be told from a
work by its page, and a profile that shows an image, a "top artist" link and a
few tags beside its works' cards can still read as a title.
Only a link the user pastes reaches this case.

**Resource bounds.** Both fetched HTML and the browser's rendered document are
capped at 5 MiB of text before extraction. DOM nesting deeper than 256 is refused
with a reason before recursive Cheerio helpers run. Wide blocks avoid Cheerio's
quadratic selector preparation; nested JSON-LD credits are read iteratively.
These bounds are generic, with regression tests alongside the extractor.

The proxy's socket/Chromium checks are opt-in: `pnpm test:browser-proxy`
requires an installed Playwright Chromium and local sockets. An existing
compatible executable can be supplied with `NHDB_TEST_CHROMIUM_PATH`.
These tests use temporary local HTTP/TLS servers and injected DNS/dial fixtures;
they contact neither public sites nor a database. The normal suite covers the
address gate and browser/proxy lifecycle without launching a browser.

**Client-rendered sites** (Hitomi builds its gallery page in the browser) have
no title in their HTML; the impit layer reads nothing and the browser layer
renders the page, waits for the network to settle, and reads the DOM.

**Covers are not the scraper's job past the URL.** The scraper stores the
cover's address; the app's `/api/cover` route fetches it when it is shown, with
the title page's origin as `Referer` (Hitomi's thumbnail host refuses requests
without one). A cover that still does not show answers the route with a
plain-text reason (`upstream answered 403`) — open the `<img>` URL in a
signed-in tab to read it.

## How scraping works

Two layers, in `lib/scraper.ts`:

1. **impit** — a TLS/HTTP2-impersonating HTTP client that passes Cloudflare's
   fingerprint gate without a browser (~150 ms). Profile via
   `SCRAPER_BROWSER_PROFILE` (default `chrome`).
2. **Playwright** — a real stealth browser kept as a warm singleton, used when
   impit is challenged, or when the page impit got did not read as a title
   (it may only exist once its scripts run). The HTTP response reports which
   layer was used as `via: "impit" | "fallback"`.

## Request shape

```
POST /scrape           Authorization: Bearer $SCRAPER_SECRET
  { "input": "177013" }                                   # nhentai id / url
  { "input": "https://somesite.example/gallery/98765/" }  # a title link on any site
  { "input": "hitomi:1234567" }                            # a legacy source:id ref (seven old keys)
  → 200 { "scraped": { "source": "somesite.example", "source_id": "98765",
                       "url": "https://somesite.example/gallery/98765/", ... }, "via": "impit" }
  → 400 { "error": "Not a link to a title: …", "code": "BAD_INPUT" }
  → 404 { "error": "… is not a title page: the page lists other titles — a listing, not a title", "code": "NOT_FOUND" }
GET  /                  → 200 { "ok": true }   # health check (no auth)
```

The app sends nhentai titles as the bare id (which every host version
understands) and other titles as their page address. A host from before it
could read any site answers an unfamiliar link with a 400; the app reports that
as "probably running an older version" and tries the next host. Update the host
to scrape any site.

## Run locally (ngrok)

```bash
pnpm scraper            # binds :3333 and opens an ngrok tunnel
```

Env (`.env` / `.env.local`): `SCRAPER_SECRET`, optional `NGROK_DOMAIN`,
optional `SCRAPER_PORT`. Disable the tunnel with `DISABLE_NGROK=1`.

## Deploy on Render

The repo ships a `Dockerfile` (Playwright base image, Chromium included) and a
`render.yaml` blueprint.

1. Render → **New + → Blueprint** → select this repo (uses `render.yaml`), or
   create a **Web Service** with runtime **Docker** pointing at the `Dockerfile`.
2. Set env var **`SCRAPER_SECRET`** (any random string) in the Render dashboard.
   Render injects `PORT` and `RENDER` automatically; the server skips ngrok and
   launches Chromium with `--no-sandbox` when `RENDER` is present.
3. After deploy, note the public URL, e.g. `https://<your-service>.onrender.com`.

## Routing: local first, Render as fallback

`/api/scrape` tries scraper hosts in order (see `app/api/scrape/route.ts`):

1. **`SCRAPER_SERVICE_URL`** — the primary. Point it at the local box's ngrok
   tunnel: on a residential IP impit's fast path passes Cloudflare (~200 ms).
2. **`SCRAPER_SERVICE_URL_FALLBACK`** — Render. Used only when the primary is
   unreachable (Mac asleep, tunnel down, timeout). On Render's datacenter IP
   Cloudflare challenges impit, so every scrape there pays the slow browser
   fallback (~15–30 s) — hence it's the backup, not the default.

A definitive verdict from the primary (404 "no such title" / 400) is returned
as-is; only an *unreachable* primary falls through to Render. The route exports
`maxDuration = 60` so the proxied browser fallback isn't cut off by Vercel's
short default timeout.

Then set these on Vercel (Project → Settings → Environment Variables):

```
SCRAPER_SERVICE_URL          = https://<your-reserved-ngrok-domain>   # local, primary
SCRAPER_SERVICE_URL_FALLBACK = https://<your-service>.onrender.com      # Render, backup
SCRAPER_SECRET               = <one secret, identical on the Mac and Render>
```

Notes:
- **One secret for both hosts** — the route sends the same `Bearer` to the
  primary and the fallback, so `SCRAPER_SECRET` must match in the Mac's `.env`
  and in Render's dashboard.
- **ngrok needs a reserved domain** (`NGROK_DOMAIN` in the Mac's `.env`), else
  the tunnel URL changes on restart and the Vercel var goes stale.
- The **free** Render plan spins down on idle → if the Mac is also offline, the
  first fallback scrape pays a cold start (~60–90 s) and may exceed the 60 s
  function budget; a retry usually lands once the container is warming. **Starter**
  avoids this (never sleeps, more RAM for Chromium).
- The scraper needs **no database** — Vercel persists scraped results.
