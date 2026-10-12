// Title scraper — two layers, any gallery site:
//   1. impit  — a TLS/HTTP2-impersonating HTTP client that passes Cloudflare's
//      fingerprint gate without a browser (fast, ~200ms, no process launch).
//   2. Playwright — a real (stealth) browser kept as a WARM session, used when
//      impit is challenged/blocked or when the page's HTML holds no title until
//      its JavaScript runs (client-rendered sites).
//
// Nothing here knows a site. The input is reduced to a (site, id, page) ref by
// lib/sources.ts, the page is read by the site-agnostic lib/scrapers/extract.ts,
// and the reading may say "follow" (a content warning's "View Gallery", a
// reader page's link back to its gallery) — at most MAX_HOPS times, and only to
// the same site. Every address is checked to resolve to public addresses before
// it is fetched: the scraper fetches what users paste.
//
// Both impit and playwright-extra are imported lazily so Vercel (proxy mode)
// never loads their native binaries when scrapeTitle is not actually called.

import { parseScrapePayload, scrapedRef, type ScrapeResult } from "./scrape-payload";
import { galleryIdOf, isSameSite, parseTitleRef, parseWebUrl, refFromUrl, refKey, refLabel, siteName, type TitleRef } from "./sources";
import { looksLikeChallenge, looksLikeHtml, ScrapeError } from "./scrapers/common";
import { readPage, type PageReading } from "./scrapers/extract";
import { assertPublicHostname, UnsafeUrlError } from "./net-address";
import { startScraperProxy, type ScraperProxy } from "./scraper-proxy";
import { SCRAPER_BROWSER_NETWORK_ARGS } from "./scraper-browser-options";

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

// Pages bigger than this are not a gallery's.
const MAX_HTML = 5 * 1024 * 1024;
// Content warning → gallery, reader page → gallery: two is the most a real
// title needs; more is a loop.
const MAX_HOPS = 2;

function describe(ref: TitleRef): string {
  return `${refLabel(ref)} on ${siteName(ref.source)}`;
}

// A redesigned site may prefix an old title slug with its numeric id. Keep
// the requested slug identity when the landed segment repeats its full words.
function repeatsTitleSlug(url: URL, id: string): boolean {
  const words = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const slug = words(id);
  if (/^\d/.test(id) || id.includes("/") || slug.length < 8) return false;
  return url.pathname.split("/").some((segment) => {
    try {
      const landed = words(decodeURIComponent(segment));
      return landed === slug || landed.endsWith(` ${slug}`);
    } catch {
      return false;
    }
  });
}

// Where a response finally came from, once redirects were followed. A page
// that bounced to another site is not read — whatever is there, it is not the
// title that was asked for. A gallery the site replaced answers with a
// permanent redirect to its successor (IMHentai: /gallery/1200000/ → 301 →
// /gallery/1146802/); reading it would file the successor under the id asked
// for, so the user is pointed at it instead.
function assertLanded(finalUrl: string, ref: TitleRef): void {
  const url = parseWebUrl(finalUrl);
  if (!url || !isSameSite(url.hostname, new URL(ref.url).hostname)) {
    throw new ScrapeError(`${describe(ref)} redirected off the site — not a title page`, "NOT_FOUND");
  }
  const landed = galleryIdOf(url);
  if (landed && landed !== ref.id && !repeatsTitleSlug(url, ref.id)) {
    const other = refFromUrl(url.toString());
    throw new ScrapeError(
      `${describe(ref)} now redirects to ${other ? refLabel(other) : url.pathname} — add that one instead`,
      "NOT_FOUND",
    );
  }
}

// Every fetch is of an address a user typed, or a link on a page they named.
// A site that does not resolve (a dead mirror) is a verdict about the title —
// NOT_FOUND; one that resolves into a private network is refused as input.
async function assertFetchable(raw: string): Promise<void> {
  const url = parseWebUrl(raw);
  if (!url) throw new ScrapeError(`not a web address: ${raw.slice(0, 120)}`, "BAD_INPUT");
  try {
    await assertPublicHostname(url.hostname);
  } catch (e) {
    const message = e instanceof UnsafeUrlError ? e.message : `cannot reach ${url.hostname}`;
    throw new ScrapeError(message, /could not resolve/i.test(message) ? "NOT_FOUND" : "BAD_INPUT");
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

// The page as impit sees it, or null to signal "fall back to the browser"
// (challenged, blocked, or an error status the browser might get past).
// Throws ScrapeError only for a genuine 404 (which the browser would also hit)
// or a redirect off the site / to another title / into a private network.
//
// Redirects are followed BY HAND: impit would follow them itself, and the
// request would reach wherever the Location points — 127.0.0.1, the router —
// before anything looked at it. Each hop is checked like the first address:
// on the site, the same title, resolving to public addresses only.
async function fetchViaImpit(url: string, ref: TitleRef): Promise<{ html: string; url: string } | null> {
  let res: Awaited<ReturnType<ImpitInstance["fetch"]>>;
  let current = url;
  for (let hop = 0; ; hop++) {
    try {
      const impit = await getImpit();
      res = await impit.fetch(current, { headers: { "Accept-Language": "en-US,en;q=0.9" }, redirect: "manual" });
    } catch (e) {
      console.warn(`[scraper] impit request failed for ${describe(ref)}, falling back:`, e instanceof Error ? e.message : e);
      return null;
    }
    if (!REDIRECT_STATUSES.has(res.status)) break;
    const location = res.headers.get("location");
    if (!location || hop >= MAX_REDIRECTS) return null;
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new ScrapeError(`${describe(ref)} redirected to an unusable address`, "NOT_FOUND");
    }
    assertLanded(next, ref);
    await assertFetchable(next);
    current = next;
  }

  if (res.status === 404 || res.status === 410) {
    throw new ScrapeError(`Title ${describe(ref)} not found (${res.status})`, "NOT_FOUND");
  }
  const finalUrl = current;
  assertLanded(finalUrl, ref);

  const body = await res.text().catch(() => "");
  if (res.status !== 200 || body.length > MAX_HTML || looksLikeChallenge(body) || !looksLikeHtml(body)) {
    return null;
  }
  return { html: body, url: finalUrl };
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
type WarmBrowser = { browser: PWBrowser; context: PWBrowserContext; proxy: ScraperProxy };
let _warm: Promise<WarmBrowser> | null = null;

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

async function closeWarm(warm: WarmBrowser): Promise<void> {
  try { await warm.browser.close(); }
  finally { await warm.proxy.close(); }
}

async function launchWarm(): Promise<WarmBrowser> {
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
  const proxy = await startScraperProxy();
  let browser: PWBrowser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath,
      proxy: { server: proxy.server },
      args: [
        ...lambdaArgs,
        "--disable-blink-features=AutomationControlled",
        // Force loopback through the gate even if Playwright's implicit bypass
        // override is disabled in the environment.
        ...SCRAPER_BROWSER_NETWORK_ARGS,
        ...(noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
      ],
    });

    // A post-launch crash must not leave a dead browser cached forever — uncache
    // so the next scrape relaunches. Only clear _warm if it still points at THIS
    // browser (closeScraper / a newer launch may have replaced it already).
    browser.on("disconnected", () => {
      void proxy.close().catch(() => {});
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

    return { browser, context, proxy };
  } catch (e) {
    try { await browser?.close(); }
    finally { await proxy.close(); }
    throw e;
  }
}

function getWarm(): Promise<WarmBrowser> {
  if (!_warm) {
    const warm = launchWarm();
    _warm = warm;
    // A failed launch must not be cached forever.
    warm.catch(() => { if (_warm === warm) _warm = null; });
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
    await closeWarm(await warm);
  } catch {
    // already gone
  }
}

async function fetchViaBrowser(url: string, ref: TitleRef): Promise<{ html: string; url: string }> {
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
      await warm.then(closeWarm).catch(() => {});
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
    assertLanded(page.url(), ref);

    // No site-specific "ready" selector: let the page's own scripts finish
    // building it (client-rendered galleries fill in after load), then read.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const title = await page.title();
    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      throw new ScrapeError("Cloudflare challenge detected", "CLOUDFLARE");
    }
    assertLanded(page.url(), ref);
    return { html: await page.content(), url: page.url() };
  } catch (e) {
    if (e instanceof ScrapeError) throw e;
    // A raw Playwright failure usually means the browser died mid-scrape —
    // uncache it (the "disconnected" handler covers most cases; this is the
    // belt to its suspenders) and surface a typed error.
    if (!browser.isConnected() && _warm === warm) {
      _warm = null;
      await warm.then(closeWarm).catch(() => {});
    }
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

// The reading goes through the same gate the app's write boundary uses, so a
// page the extractor misread fails here — at the scraper, with the reason —
// rather than as a confusing 400 when the user hits save.
function checked(reading: Extract<PageReading, { kind: "gallery" }>, ref: TitleRef, pageUrl: string): ScrapeResult {
  // A legacy site's title keeps its canonical address; any other site's is
  // the page the title was found on (a followed gallery link, not the warning
  // page or the reader), tidied the same way the pasted one was.
  const landed = refFromUrl(pageUrl);
  const candidate = {
    source: ref.source,
    source_id: ref.id,
    url: landed && refKey(landed) === refKey(ref) ? landed.url : ref.url,
    ...reading.title,
  };
  let clean: ScrapeResult;
  try {
    clean = parseScrapePayload(candidate);
  } catch (e) {
    throw new ScrapeError(`read an unusable title from ${describe(ref)}: ${e instanceof Error ? e.message : e}`, "TIMEOUT");
  }
  if (refKey(scrapedRef(clean)) !== refKey(ref)) {
    throw new ScrapeError(`${describe(ref)} answered with a different title`, "TIMEOUT");
  }
  return clean;
}

type Fetcher = (url: string, ref: TitleRef) => Promise<{ html: string; url: string } | null>;

// Fetch, read, and follow what the reading points at, with one fetcher.
// Returns the title, or why the last page was not one (null when the fetcher
// itself gave up, i.e. impit was challenged).
async function readWith(fetchPage: Fetcher, ref: TitleRef): Promise<ScrapeResult | { reason: string } | null> {
  let url = ref.url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertFetchable(url);
    const page = await fetchPage(url, ref);
    if (!page) return null;
    // The browser's rendered DOM can be larger than the fast layer's body.
    // Apply the same cap before either layer enters the synchronous parser.
    if (page.html.length > MAX_HTML) return { reason: "the page is too large to read" };
    const reading = readPage(page.html, page.url);
    if (reading.kind === "gallery") return checked(reading, ref, page.url);
    if (reading.kind === "none") return { reason: reading.reason };
    const next = parseWebUrl(reading.url);
    if (!next || !isSameSite(next.hostname, new URL(ref.url).hostname)) return { reason: "its link leads off the site" };
    console.warn(`[scraper] ${describe(ref)}: ${reading.why}`);
    url = next.toString();
  }
  return { reason: "it kept redirecting between pages" };
}

export async function scrapeTitle(input: string | TitleRef): Promise<ScrapeOutcome> {
  const ref = typeof input === "string" ? parseTitleRef(input) : refFromUrl(input.url);
  if (!ref || (typeof input !== "string" && refKey(ref) !== refKey(input))) {
    const shown = typeof input === "string" ? input : input.url;
    throw new ScrapeError(`Not a link to a title: "${shown.slice(0, 200)}"`, "BAD_INPUT");
  }

  // Layer 1: cheap impersonated fetch. null = challenged/blocked; a genuine
  // 404 is thrown here and must NOT trigger the browser fallback.
  const viaImpit = await readWith(fetchViaImpit, ref);
  if (viaImpit && "title_name" in viaImpit) return { scraped: viaImpit, via: "impit" };

  // Layer 2: a real browser — past a challenge, or to let a client-rendered
  // page build itself. A page impit read and found not to be a title gets the
  // same chance: its title may only exist once its scripts have run.
  console.warn(`[scraper] ${describe(ref)}: ${viaImpit ? viaImpit.reason : "impit did not get through"}, using the browser`);
  let viaBrowser: ScrapeResult | { reason: string } | null;
  try {
    viaBrowser = await readWith(fetchViaBrowser, ref);
  } catch (e) {
    // Both layers failed — make the message say so for the user.
    if (e instanceof ScrapeError && e.code !== "NOT_FOUND" && e.code !== "BAD_INPUT") {
      if (viaImpit) throw new ScrapeError(`${describe(ref)} is not a title page: ${viaImpit.reason}; browser fallback also failed: ${e.message}`, "NOT_FOUND");
      throw new ScrapeError(`impit was blocked and the browser fallback also failed: ${e.message}`, e.code);
    }
    throw e;
  }
  if (viaBrowser && "title_name" in viaBrowser) return { scraped: viaBrowser, via: "fallback" };
  const reason = viaBrowser?.reason ?? viaImpit?.reason ?? "no title found";
  throw new ScrapeError(`${describe(ref)} is not a title page: ${reason}`, "NOT_FOUND");
}
