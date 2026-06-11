// nhentai scraper — extracted from the standalone scrape.ts CLI.
// playwright-extra + stealth are loaded lazily so Vercel (proxy mode) never imports them.

import * as cheerio from "cheerio";

type PlaywrightExtraChromium = typeof import("playwright-extra")["chromium"];
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

export interface ScrapeEntity {
  name: string;
  link: string;
  total_works: number;
}

export interface ScrapeResult {
  hashtag: number;
  title_name: string;
  alter_name: string | null;
  title_link: string;
  image_link: string;
  pages: number;
  uploaded_at: string;
  tags: ScrapeEntity[];
  artists: ScrapeEntity[];
  groups: ScrapeEntity[];
  characters: ScrapeEntity[];
  parodies: ScrapeEntity[];
}

export function extractHashtag(input: string): number | null {
  const t = input.trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const urlMatch = t.match(/nhentai\.net\/g\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1], 10);
  const hashMatch = t.match(/^#?(\d+)$/);
  if (hashMatch) return parseInt(hashMatch[1], 10);
  return null;
}

function parseCount(raw: string): number {
  return parseInt(raw.replace(/,/g, ""), 10) || 0;
}

function parseInfoDiv(html: string, hashtag: number, pageUrl: string): ScrapeResult {
  const $ = cheerio.load(html);
  const info = $("#info");

  const title_name = info.find("h1 .pretty").text().trim();
  const alter_name = info.find("h2.title").text().trim() || null;

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
  const pages = parseInt(pagesText, 10) || 0;

  const datetimeAttr = info.find("time").attr("datetime") || new Date().toISOString();
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
    alter_name,
    title_link: pageUrl,
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

export class ScrapeError extends Error {
  constructor(message: string, public code: "BAD_INPUT" | "CLOUDFLARE" | "NOT_FOUND" | "TIMEOUT") {
    super(message);
    this.name = "ScrapeError";
  }
}

export async function scrapeTitle(input: string | number): Promise<ScrapeResult> {
  const hashtag = typeof input === "number" ? input : extractHashtag(input);
  if (!hashtag) throw new ScrapeError(`Could not parse hashtag from: "${input}"`, "BAD_INPUT");

  const url = `https://nhentai.net/g/${hashtag}/`;

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

  const chromium = await getChromium();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [...lambdaArgs, "--disable-blink-features=AutomationControlled"],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });

    const page = await context.newPage();

    await page.route("**/*", (route: import("playwright").Route) => {
      if (["image", "media", "font", "stylesheet"].includes(route.request().resourceType())) {
        route.abort();
      } else {
        route.continue();
      }
    });

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
    return parseInfoDiv(html, hashtag, url);
  } finally {
    await browser.close();
  }
}
