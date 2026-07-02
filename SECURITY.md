# Security model

## App access: Vercel Deployment Protection

The app intentionally has **no app-level authentication** — no login code, middleware,
or sessions. Access is gated at the platform level by **Vercel Deployment Protection →
Vercel Authentication**.

Enable it in the Vercel dashboard: **Project → Settings → Deployment Protection →
Vercel Authentication → on for Production** (and Preview). This single toggle covers:

- the UI (all pages),
- Server Actions,
- the `POST /api/scrape` route,
- the `/_next/image` optimizer.

## Render scraper service: `SCRAPER_SECRET`

The scraper (`scripts/scraper-server.ts`, deployed on Render) is a **separate
deployment** that Vercel Deployment Protection does not cover. It is protected by the
`SCRAPER_SECRET` bearer token: the Vercel `/api/scrape` route sends
`Authorization: Bearer <SCRAPER_SECRET>`, and the scraper server verifies it with a
constant-time compare (`timingSafeEqual`). `SCRAPER_SECRET` is the only thing
protecting the Render service — keep it set on both sides.

## Automation behind protection: `pnpm rescrape`

Running `pnpm rescrape` against a **protected production URL** (i.e. `APP_URL`
pointing at the Vercel deployment) requires a "Protection Bypass for Automation"
token. Generate it in the same **Deployment Protection** settings and set it as
`VERCEL_AUTOMATION_BYPASS_SECRET`; the script then sends the
`x-vercel-protection-bypass` header. Local runs (`APP_URL=http://localhost:3000`,
the default) need nothing.
