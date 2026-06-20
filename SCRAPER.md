# Scraper service

The scraper runs outside Vercel because the browser fallback needs a real
Chromium, which Vercel's serverless runtime can't host comfortably. Vercel's
`/api/scrape` proxies to it when `SCRAPER_SERVICE_URL` is set.

## How scraping works

Two layers, in `lib/scraper.ts`:

1. **impit** — a TLS/HTTP2-impersonating HTTP client that passes nhentai's
   Cloudflare fingerprint gate without a browser (~150 ms). Profile via
   `SCRAPER_BROWSER_PROFILE` (default `chrome`).
2. **Playwright** — a real stealth browser kept as a warm singleton, used only
   when impit is challenged. The HTTP response reports which layer was used as
   `via: "impit" | "fallback"`.

## Request shape

```
POST /scrape           Authorization: Bearer $SCRAPER_SECRET
  { "input": "177013" }                       # url / #id / id
  → 200 { "scraped": {...}, "via": "impit" }
GET  /                  → 200 { "ok": true }   # health check (no auth)
```

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
