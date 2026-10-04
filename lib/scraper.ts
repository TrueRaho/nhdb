// Title scraper — two layers, any supported site:
//   1. impit  — a TLS/HTTP2-impersonating HTTP client that passes Cloudflare's
//      fingerprint gate without a browser (fast, ~200ms, no process launch).
//   2. Playwright — a real (stealth) browser kept as a WARM session and only
//      used as a fallback when impit gets challenged/blocked, for the sites
//      whose title page is HTML behind Cloudflare.
//
// What to fetch and how to read it is per site (lib/scrapers/*): the input is
// first reduced to a (site, id) pair by lib/sources.ts, and the request is
// rebuilt from that pair — the address the user pasted is never fetched.
//
// Both impit and playwright-extra are imported lazily so Vercel (proxy mode)
// never loads their native binaries when scrapeTitle is not actually called.

import { parseScrapePayload, scrapedRef, type ScrapeResult } from "./scrape-payload";
import { parseTitleRef, refKey, refLabel, SOURCES, toTitleRef, type TitleRef } from "./sources";
import { looksLikeChallenge, ScrapeError, type SiteAdapter, type SiteRequest } from "./scrapers/common";
import { ADAPTERS } from "./scrapers";

export { ScrapeError, looksLikeChallenge };
export type { ScrapeEntity, ScrapeResult } from "./scrape-payload";

// Which layer produced the result. "fallback" means impit was blocked and a
// real browser had to take over — surfaced to the UI so the user knows.
export type ScrapeVia = "impit" | "fallback";

export interface ScrapeOutcome {
  scraped: ScrapeResult;
  via: ScrapeVia;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Where a response finally came from, once redirects were followed. A title
// page that bounces to another host is not read — whatever is there, it is
// not the title that was asked for.
function onFetchHosts(finalUrl: string, site: SiteAdapter): boolean {
  try {
    return site.fetchHosts.includes(new URL(finalUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function describe(ref: TitleRef): string {
  return `${refLabel(ref)} on ${SOURCES[ref.source].name}`;
}

// A gallery the site replaced answers with a permanent redirect to its
// successor (IMHentai: /gallery/1200000/ → 301 → /gallery/1146802/). The parse
// would file the successor's metadata under the id that was asked for, and a
// later add of the successor would then be a second row for one title — so
// the user is pointed at it instead.
function assertSameTitle(finalUrl: string, ref: TitleRef): void {
  const landed = parseTitleRef(finalUrl);
  if (landed && landed.source === ref.source && landed.id !== ref.id) {
    throw new ScrapeError(`${describe(ref)} now redirects to ${refLabel(landed)} — add that one instead`, "NOT_FOUND");
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — impit (TLS/HTTP2 impersonation, no browser)
// ---------------------------------------------------------------------------

// Which browser fingerprint impit emulates. Use the non-pinned alias "chrome"
// (tracks the newest profile the installed impit ships) so upgrades need no
// code change; override per-environment with SCRAPER_BROWSER_PROFILE.
const IMPIT_PROFILE = process.env.SCRAPER_BROWSER_PROFILE || "chrome";

type ImpitInstance = InstanceType<typeof import("impit").Impit>;
let _impit: ImpitInstance | null = null;

async function getImpit(): Promise<ImpitInstance> {
  if (!_impit) {
    const { Impit } = await import("impit");
    // An invalid SCRAPER_BROWSER_PROFILE makes fetches throw, and we simply
    // fall back to the browser layer — so the env value is trusted, not validated.
    _impit = new Impit({
      browser: IMPIT_PROFILE as import("impit").Browser,
      timeout: 30_000,
    });
  }
  return _impit;
}

// Returns the site's answer, or null to signal "fall back to browser".
// Throws ScrapeError only for a genuine 404 (which the browser would also hit)
// or a redirect off the site.
async function fetchViaImpit(site: SiteAdapter, req: SiteRequest, ref: TitleRef): Promise<string | null> {
  let res: Awaited<ReturnType<ImpitInstance["fetch"]>>;
  try {
    const impit = await getImpit();
    res = await impit.fetch(req.url, { method: req.method ?? "GET", headers: req.headers, body: req.body });
  } catch (e) {
    console.warn(`[scraper] impit request failed for ${describe(ref)}, falling back:`, e instanceof Error ? e.message : e);
    return null;
  }

  if (res.status === 404 || res.status === 410) {
    throw new ScrapeError(`Title ${describe(ref)} not found (${res.status})`, "NOT_FOUND");
  }
  if (!onFetchHosts(res.url || req.url, site)) {
    throw new ScrapeError(`${describe(ref)} redirected off the site — not a title page`, "NOT_FOUND");
  }
  assertSameTitle(res.url || req.url, ref);

  const body = await res.text().catch(() => "");
  if (res.status !== 200 || looksLikeChallenge(body) || !site.isComplete(body)) {
    return null;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Layer 2 — Playwright warm session (fallback)
// ---------------------------------------------------------------------------

type PlaywrightExtraChromium = typeof import("playwright-extra")["chromium"];
type PWBrowser = import("playwright").Browser;
type PWBrowserContext = import("playwright").BrowserContext;

let _chromium: PlaywrightExtraChromium | null = null;

async function getChromium(): Promise<PlaywrightExtraChromium> {
  if (!_chromium) {
    const { chromium } = await import("playwright-extra");
    const { default: stealth } = await import("puppeteer-extra-plugin-stealth");
    chromium.use(stealth());
    _chromium = chromium;
  }
  return _chromium;
}

// A single browser + context kept alive across scrapes. The first browser-layer
// scrape launches it; subsequent ones reuse it (no per-title launch). An idle
// timer closes it after inactivity so long-running servers don't hold a browser
// forever; callers can also close it explicitly via closeScraper().
let _warm: Promise<{ browser: PWBrowser; context: PWBrowserContext }> | null = null;

const IDLE_MS = Number(process.env.SCRAPER_BROWSER_IDLE_MS ?? 60_000);
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
// Browser scrapes currently in flight. The standalone server handles requests
// concurrently, so scrape A finishing must not arm the idle timer while scrape
// B is still driving the shared warm browser — the timer would close it under
// B's page.goto.
let _activeBrowserScrapes = 0;

function scheduleIdleClose(): void {
  if (_idleTimer) clearTimeout(_idleTimer);
  if (IDLE_MS > 0 && _activeBrowserScrapes === 0) {
    _idleTimer = setTimeout(() => void closeScraper(), IDLE_MS);
    _idleTimer.unref?.();
  }
}

async function launchWarm(): Promise<{ browser: PWBrowser; context: PWBrowserContext }> {
  // @sparticuz/chromium ships a Linux binary — only use it in actual serverless
  // environments, not for any production build (next start on macOS would ENOEXEC).
  const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  let executablePath: string | undefined;
  let lambdaArgs: string[] = [];
  if (isServerless) {
    const chromiumLambda = (await import("@sparticuz/chromium")).default;
    executablePath = await chromiumLambda.executablePath();
    lambdaArgs = chromiumLambda.args;
  }

  // Chromium refuses to run as root (Render / most Docker containers) unless
  // sandboxing is disabled. RENDER is set automatically on Render.
  const noSandbox = !!process.env.RENDER || process.env.SCRAPER_NO_SANDBOX === "1";

  const chromium = await getChromium();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      ...lambdaArgs,
      "--disable-blink-features=AutomationControlled",
      ...(noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
    ],
  });

  // A post-launch crash must not leave a dead browser cached forever — uncache
  // so the next scrape relaunches. Only clear _warm if it still points at THIS
  // browser (closeScraper / a newer launch may have replaced it already).
  browser.on("disconnected", () => {
    const cached = _warm;
    if (!cached) return;
    cached
      .then((w) => {
        if (w.browser === browser && _warm === cached) _warm = null;
      })
      .catch(() => {});
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  // Skip subresources for speed — we only need the server-rendered HTML.
  // abort()/continue() reject ("Target page closed") when the page is closing;
  // the rejections are fire-and-forget so they MUST be observed or they become
  // unhandled rejections that crash the standalone server process.
  await context.route("**/*", (route: import("playwright").Route) => {
    if (["image", "media", "font", "stylesheet"].includes(route.request().resourceType())) {
      route.abort().catch(() => {});
    } else {
      route.continue().catch(() => {});
    }
  });

  return { browser, context };
}

function getWarm(): Promise<{ browser: PWBrowser; context: PWBrowserContext }> {
  if (!_warm) {
    _warm = launchWarm();
    // A failed launch must not be cached forever.
    _warm.catch(() => { _warm = null; });
  }
  return _warm;
}

// Closes the warm browser if one is open. Safe to call when nothing is running.
// Long-running hosts (the scraper-server) should call this on shutdown.
export async function closeScraper(): Promise<void> {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const warm = _warm;
  _warm = null;
  if (!warm) return;
  try {
    const { browser } = await warm;
    await browser.close();
  } catch {
    // already gone
  }
}

async function fetchViaBrowser(site: SiteAdapter, url: string, ref: TitleRef): Promise<string> {
  // Disarm any pending idle-close FIRST: a scrape starting just before the
  // timer fires must not have closeScraper() pull the browser out from under
  // its page.goto. The counter keeps a concurrent scrape's `finally` from
  // re-arming it while we're still running; ours re-arms once the last one is done.
  _activeBrowserScrapes++;
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }

  const warm = getWarm();
  let browser: PWBrowser;
  let page: import("playwright").Page;
  try {
    const w = await warm;
    browser = w.browser;
    page = await w.context.newPage();
  } catch (e) {
    // Launch failed or the cached browser died — uncache so the next call
    // relaunches instead of reusing a dead session forever. If the browser
    // itself is alive (newPage failed some other way), close it too: nulling
    // _warm alone would orphan a live Chromium process nothing can reach again.
    if (_warm === warm) {
      _warm = null;
      warm.then((w) => void w.browser.close().catch(() => {})).catch(() => {});
    }
    _activeBrowserScrapes--;
    scheduleIdleClose();
    throw new ScrapeError(
      `could not acquire a browser page: ${e instanceof Error ? e.message : String(e)}`,
      "TIMEOUT"
    );
  }

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (response && (response.status() === 404 || response.status() === 410)) {
      throw new ScrapeError(`Title ${describe(ref)} not found (${response.status()})`, "NOT_FOUND");
    }
    if (!onFetchHosts(page.url(), site)) {
      throw new ScrapeError(`${describe(ref)} redirected off the site — not a title page`, "NOT_FOUND");
    }
    assertSameTitle(page.url(), ref);

    const title = await page.title();
    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      throw new ScrapeError("Cloudflare challenge detected", "CLOUDFLARE");
    }

    try {
      await page.waitForSelector(site.browserReady!, { timeout: 10_000 });
    } catch {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (title.includes("404") || bodyText.includes("Page not found") || bodyText.includes("404")) {
        throw new ScrapeError(`Title ${describe(ref)} not found (404)`, "NOT_FOUND");
      }
      throw new ScrapeError(`${site.browserReady} not found — page did not load`, "TIMEOUT");
    }

    return await page.content();
  } catch (e) {
    if (e instanceof ScrapeError) throw e;
    // A raw Playwright failure usually means the browser died mid-scrape —
    // uncache it (the "disconnected" handler covers most cases; this is the
    // belt to its suspenders) and surface a typed error.
    if (!browser.isConnected() && _warm === warm) _warm = null;
    throw new ScrapeError(
      `browser scrape failed: ${e instanceof Error ? e.message : String(e)}`,
      "TIMEOUT"
    );
  } finally {
    await page.close().catch(() => {});
    _activeBrowserScrapes--;
    scheduleIdleClose();
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

// The parser's output goes through the same gate the app's write boundary
// uses, so a site whose markup drifted fails here — at the scraper, with the
// reason — rather than as a confusing 400 when the user hits save.
function checked(scraped: ScrapeResult, ref: TitleRef): ScrapeResult {
  let clean: ScrapeResult;
  try {
    clean = parseScrapePayload(scraped);
  } catch (e) {
    throw new ScrapeError(
      `parsed an unusable title for ${describe(ref)} — markup drift? ${e instanceof Error ? e.message : e}`,
      "TIMEOUT",
    );
  }
  if (refKey(scrapedRef(clean)) !== refKey(ref)) {
    throw new ScrapeError(`${describe(ref)} answered with a different title`, "TIMEOUT");
  }
  return clean;
}

export async function scrapeTitle(input: string | TitleRef): Promise<ScrapeOutcome> {
  const ref = typeof input === "string" ? parseTitleRef(input) : toTitleRef(input.source, input.id);
  if (!ref) {
    const shown = typeof input === "string" ? input : refKey(input);
    throw new ScrapeError(`Not a title link from a supported site: "${shown.slice(0, 200)}"`, "BAD_INPUT");
  }
  const site = ADAPTERS[ref.source];
  const req = site.request(ref.id);

  // Layer 1: cheap impersonated fetch. Returns null when challenged/blocked
  // (a genuine 404 is thrown here and must NOT trigger the browser fallback).
  const viaImpit = await fetchViaImpit(site, req, ref);
  if (viaImpit !== null) return { scraped: checked(site.parse(viaImpit, ref.id), ref), via: "impit" };

  // JSON endpoints have no page for a browser to render — impit was the only way.
  if (!site.browserReady) {
    throw new ScrapeError(`${SOURCES[ref.source].name} did not answer for ${refLabel(ref)}`, "TIMEOUT");
  }

  // Layer 2: a real browser solves whatever impit couldn't get past.
  console.warn(`[scraper] impit layer did not pass for ${describe(ref)}, using Playwright fallback`);
  try {
    const html = await fetchViaBrowser(site, req.url, ref);
    return { scraped: checked(site.parse(html, ref.id), ref), via: "fallback" };
  } catch (e) {
    // Both layers failed — make the message say so for the user.
    if (e instanceof ScrapeError && e.code !== "NOT_FOUND") {
      throw new ScrapeError(`impit was blocked and the browser fallback also failed: ${e.message}`, e.code);
    }
    throw e;
  }
}
