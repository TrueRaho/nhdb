// nhentai scraper — two layers:
//   1. impit  — a TLS/HTTP2-impersonating HTTP client that passes Cloudflare's
//      fingerprint gate without a browser (fast, ~200ms, no process launch).
//   2. Playwright — a real (stealth) browser kept as a WARM session and only
//      used as a fallback when impit gets challenged/blocked.
//
// Both impit and playwright-extra are imported lazily so Vercel (proxy mode)
// never loads their native binaries when scrapeTitle is not actually called.

import * as cheerio from "cheerio";
import { extractHashtag } from "./utils";

export { extractHashtag };

export interface ScrapeEntity {
  name: string;
  link: string;
  total_works: number;
}

// alter_name is intentionally absent: it is a user-managed custom name,
// never collected by the scraper.
export interface ScrapeResult {
  hashtag: number;
  title_name: string;
  image_link: string;
  pages: number;
  uploaded_at: string;
  tags: ScrapeEntity[];
  artists: ScrapeEntity[];
  groups: ScrapeEntity[];
  characters: ScrapeEntity[];
  parodies: ScrapeEntity[];
}

export class ScrapeError extends Error {
  constructor(message: string, public code: "BAD_INPUT" | "CLOUDFLARE" | "NOT_FOUND" | "TIMEOUT") {
    super(message);
    this.name = "ScrapeError";
  }
}

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

// ---------------------------------------------------------------------------
// Parsing (shared by both layers)
// ---------------------------------------------------------------------------

function parseCount(raw: string): number {
  return parseInt(raw.replace(/,/g, ""), 10) || 0;
}

function parseInfoDiv(html: string, hashtag: number): ScrapeResult {
  const $ = cheerio.load(html);
  const info = $("#info");

  const title_name = info.find("h1 .pretty").text().trim();
  // An empty title means the selector no longer matches (markup drift) or the
  // page served an empty #info — fail loudly rather than upsert a blank record
  // that a later `rescrape --all` would overwrite good data with.
  if (title_name === "") {
    throw new ScrapeError(`parsed empty title for #${hashtag} — markup drift?`, "TIMEOUT");
  }

  const image_link =
    $("div#cover img").attr("data-src") ||
    $("div#cover img").attr("src") ||
    "";

  const pagesText = info
    .find(".tag-container")
    .filter((_, el) => $(el).text().trimStart().startsWith("Pages:"))
    .find(".name")
    .first()
    .text();
  const pages = parseCount(pagesText);

  // Never fabricate an upload date: a missing/malformed datetime attr would
  // otherwise get stamped as "today" and re-stamped on every re-scrape.
  const datetimeAttr = (info.find("time").attr("datetime") ?? "").trim();
  if (datetimeAttr === "" || Number.isNaN(Date.parse(datetimeAttr))) {
    throw new ScrapeError(`missing or malformed upload date for #${hashtag}`, "TIMEOUT");
  }
  const uploaded_at = datetimeAttr.split("T")[0];

  const extractEntities = (label: string): ScrapeEntity[] => {
    const container = info
      .find(".tag-container")
      .filter((_, el) => $(el).text().trimStart().startsWith(label));

    const entities: ScrapeEntity[] = [];
    container.find("a.tag, a.tagchip").each((_, el) => {
      const name = $(el).find(".name").text().trim();
      const total_works = parseCount($(el).find(".count").text());
      const href = $(el).attr("href") || "";
      entities.push({ name, link: href, total_works });
    });
    return entities;
  };

  return {
    hashtag,
    title_name,
    image_link,
    pages,
    uploaded_at,
    tags: extractEntities("Tags:"),
    artists: extractEntities("Artists:"),
    groups: extractEntities("Groups:"),
    characters: extractEntities("Characters:"),
    parodies: extractEntities("Parodies:"),
  };
}

// Cloudflare interstitials served instead of the real page.
function looksLikeChallenge(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return (
    head.includes("just a moment") ||
    head.includes("attention required") ||
    head.includes("cf-browser-verification") ||
    head.includes("challenge-platform")
  );
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

// Returns a ScrapeResult on success, or null to signal "fall back to browser".
// Throws ScrapeError only for a genuine 404 (which the browser would also hit).
async function scrapeViaImpit(url: string, hashtag: number): Promise<ScrapeResult | null> {
  let res: Awaited<ReturnType<ImpitInstance["fetch"]>>;
  try {
    const impit = await getImpit();
    res = await impit.fetch(url);
  } catch (e) {
    console.warn(`[scraper] impit request failed for #${hashtag}, falling back:`, e instanceof Error ? e.message : e);
    return null;
  }

  if (res.status === 404) {
    throw new ScrapeError(`Title #${hashtag} not found on nhentai (404)`, "NOT_FOUND");
  }

  const html = await res.text().catch(() => "");
  if (res.status !== 200 || looksLikeChallenge(html) || !html.includes('id="info"')) {
    return null;
  }

  return parseInfoDiv(html, hashtag);
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

function scheduleIdleClose(): void {
  if (_idleTimer) clearTimeout(_idleTimer);
  if (IDLE_MS > 0) {
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

async function scrapeViaBrowser(url: string, hashtag: number): Promise<ScrapeResult> {
  // Disarm any pending idle-close FIRST: a scrape starting just before the
  // timer fires must not have closeScraper() pull the browser out from under
  // its page.goto. The `finally` below re-arms it once we're done.
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
    // relaunches instead of reusing a dead session forever.
    if (_warm === warm) _warm = null;
    throw new ScrapeError(
      `could not acquire a browser page: ${e instanceof Error ? e.message : String(e)}`,
      "TIMEOUT"
    );
  }

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const title = await page.title();
    if (title.includes("Just a moment") || title.includes("Attention Required")) {
      throw new ScrapeError("Cloudflare challenge detected", "CLOUDFLARE");
    }

    try {
      await page.waitForSelector("#info", { timeout: 10_000 });
    } catch {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (title.includes("404") || bodyText.includes("Page not found") || bodyText.includes("404")) {
        throw new ScrapeError(`Title #${hashtag} not found on nhentai (404)`, "NOT_FOUND");
      }
      throw new ScrapeError("#info element not found — page did not load", "TIMEOUT");
    }

    const html = await page.content();
    return parseInfoDiv(html, hashtag);
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
    scheduleIdleClose();
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function scrapeTitle(input: string | number): Promise<ScrapeOutcome> {
  const hashtag = typeof input === "number" ? input : extractHashtag(input);
  if (!hashtag) throw new ScrapeError(`Could not parse hashtag from: "${input}"`, "BAD_INPUT");

  const url = `https://nhentai.net/g/${hashtag}/`;

  // Layer 1: cheap impersonated fetch. Returns null when challenged/blocked
  // (a genuine 404 is thrown here and must NOT trigger the browser fallback).
  const viaImpit = await scrapeViaImpit(url, hashtag);
  if (viaImpit) return { scraped: viaImpit, via: "impit" };

  // Layer 2: a real browser solves whatever impit couldn't get past.
  console.warn(`[scraper] impit layer did not pass for #${hashtag}, using Playwright fallback`);
  try {
    const scraped = await scrapeViaBrowser(url, hashtag);
    return { scraped, via: "fallback" };
  } catch (e) {
    // Both layers failed — make the message say so for the user.
    if (e instanceof ScrapeError && e.code !== "NOT_FOUND") {
      throw new ScrapeError(`impit was blocked and the browser fallback also failed: ${e.message}`, e.code);
    }
    throw e;
  }
}
