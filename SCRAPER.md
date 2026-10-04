# Scraper service

The scraper runs outside Vercel because the browser fallback needs a real
Chromium, which Vercel's serverless runtime can't host comfortably. Vercel's
`/api/scrape` proxies to it when `SCRAPER_SERVICE_URL` is set.

## Supported sites

Every input is first reduced to a `(site, id)` pair by the allow-list in
`lib/sources.ts` — only a site's **title page** matches; search, tag and listing
pages and any other host are refused with `400 BAD_INPUT`. The scraper then
fetches the address it rebuilds from the id, never the text it was given. Each
site has an adapter in `lib/scrapers/`:

| site | accepted links | what is read | browser fallback |
| --- | --- | --- | --- |
| nhentai | `nhentai.net/g/<id>`, or a bare number | the gallery page's `#info` block | yes |
| E-Hentai | `e-hentai.org/g/<gid>/<token>` | the public `gdata` JSON API (`api.e-hentai.org`) | no (API) |
| Hitomi | `hitomi.la/galleries/<id>.html`, `/reader/…`, `/doujinshi/<title>-<id>.html`… | the gallery script `ltn.gold-usergeneratedcontent.net/galleries/<id>.js` | no (JSON) |
| HentaiFox | `hentaifox.com/gallery/<id>`, `/g/<id>/…` | the gallery page (h1 + entity links) | yes |
| IMHentai | `imhentai.xxx/gallery/<id>`, `/view/<id>/…` | the gallery page (same engine as HentaiFox) | yes |
| Pururin | `pururin.me/gallery/<id>/…`, `/read/<id>/…` (old `.to`/`.io` too) | the gallery page (labeled table / JSON rows) | yes |
| Hentai2Read | `hentai2read.com/<slug>/` (and its chapters) | the title page (schema.org Book block) | yes |

What every adapter guarantees, whatever the site's markup:

- **Only titles.** A page without the site's title markup (a listing, a removed
  gallery, the home page after a redirect) fails as `NOT_FOUND`; a response
  that redirected to another host is not read at all.
- **One vocabulary.** Entity names are folded to lowercase, whitespace-collapsed
  NFKC (`Big Breasts` → `big breasts`); E-Hentai's `female:`/`male:` namespaces
  and Hitomi's ♀/♂ flags are dropped from the name and kept in the link. That is
  what makes a tag filter, related tags and ghost tags see one "big breasts"
  across sites.
- **Nothing invented.** A site that prints no upload date (HentaiFox,
  Hentai2Read) stores `null`, shown as "—"; a page count that is not on the
  page (Hentai2Read lists chapters, not pages) stays `0`.
- **Self-checked.** The parse goes through the same validator the app's write
  boundary uses (`lib/scrape-payload.ts`), so markup drift fails at the
  scraper, with the reason, instead of as a 400 on save.

Titles keep their bracketed lead/tail out of the name the way nhentai's
`.pretty` title does: `(C92) [Circle (Artist)] Title (Parody) [English]` is
stored as `Title` — the brackets are already the title's entities.

**Verification status.** nhentai is the long-running production path. The other
adapters are built against each site's documented shape (the E-H wiki's
`gdata` example, the `galleryinfo` fields gallery-dl and node-hitomi read, the
markup gallery-dl's extractors parse) and pinned by fixture tests in
`lib/scrapers/sites.test.ts`; they have not been run against the live sites
from CI. If a site changes its markup, the scrape fails loudly (`markup
drift?`), and the fixture for that site is the place to start.

## How scraping works

Two layers, in `lib/scraper.ts`:

1. **impit** — a TLS/HTTP2-impersonating HTTP client that passes Cloudflare's
   fingerprint gate without a browser (~150 ms). Profile via
   `SCRAPER_BROWSER_PROFILE` (default `chrome`). JSON sources (E-Hentai,
   Hitomi) use this layer only.
2. **Playwright** — a real stealth browser kept as a warm singleton, used only
   when impit is challenged on an HTML title page. The HTTP response reports
   which layer was used as `via: "impit" | "fallback"`.

## Request shape

```
POST /scrape           Authorization: Bearer $SCRAPER_SECRET
  { "input": "177013" }                                  # nhentai id / url
  { "input": "https://hitomi.la/galleries/1234567.html" } # any supported title link
  { "input": "hitomi:1234567" }                           # or its source:id ref
  → 200 { "scraped": { "source": "hitomi", "source_id": "1234567", ... }, "via": "impit" }
  → 400 { "error": "Not a title link from a supported site: …", "code": "BAD_INPUT" }
GET  /                  → 200 { "ok": true }   # health check (no auth)
```

The app sends nhentai titles as the bare id (which every host version
understands) and other sites as the rebuilt gallery URL. A host from before
multi-site support answers those with a 400; the app reports that as "probably
running an older version" and tries the next host. Update the host to scrape the
other sites.

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
