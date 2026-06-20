import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { scrapeTitle, ScrapeError, type ScrapeResult, type ScrapeVia } from "@/lib/scraper";
import { upsertScrapedTitle } from "@/lib/titles";

// The proxied browser fallback (esp. on Render) can take ~15-30s; let the
// function wait it out instead of the platform's short default timeout.
export const maxDuration = 60;

// Per-host timeouts so a sleeping primary can't eat the whole 60s budget before
// the fallback gets its turn. The local box is fast (impit ~200ms); Render's
// warm browser fallback runs ~15-30s.
const SCRAPER_PRIMARY_TIMEOUT_MS = 12_000;
const SCRAPER_FALLBACK_TIMEOUT_MS = 45_000;

type ScraperCall =
  | { kind: "ok"; scraped?: ScrapeResult; via?: ScrapeVia }
  | { kind: "answered"; status: number; data: unknown }
  | { kind: "unreachable"; response: NextResponse };

// Calls one scraper host. "answered" = reachable and gave a definitive verdict
// about the input (404/400) — don't retry elsewhere. "unreachable" = network
// error, timeout, HTML error page (tunnel down), or a non-input error — the
// caller should fall through to the next host.
async function callScraper(baseUrl: string, input: string, timeoutMs: number): Promise<ScraperCall> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SCRAPER_SECRET ? { Authorization: `Bearer ${process.env.SCRAPER_SECRET}` } : {}),
      },
      body: JSON.stringify({ input }),
      signal: controller.signal,
    });
  } catch {
    return {
      kind: "unreachable",
      response: NextResponse.json({ error: "Scraper service unreachable" }, { status: 503 }),
    };
  } finally {
    clearTimeout(timer);
  }

  // ngrok/proxies return HTML error pages when the tunnel is down — a JSON parse
  // failure means "not a real scraper response", so fall through to the next host.
  let data: { scraped?: ScrapeResult; error?: string; via?: ScrapeVia; code?: string };
  try {
    data = await upstream.json();
  } catch {
    return {
      kind: "unreachable",
      response: NextResponse.json(
        { error: `Scraper service returned an invalid response (HTTP ${upstream.status})` },
        { status: 502 },
      ),
    };
  }

  if (upstream.ok) return { kind: "ok", scraped: data.scraped, via: data.via };
  if (upstream.status === 400 || upstream.status === 404) {
    return { kind: "answered", status: upstream.status, data };
  }
  return {
    kind: "unreachable",
    response: NextResponse.json(data, { status: upstream.status }),
  };
}

// Route Handlers may not call updateTag — revalidateTag(tag, "max") marks the
// entries stale instead (the UI goes through commitScrapedAction for instant reads).
function invalidateAfterUpsert(hashtag: number) {
  revalidateTag("titles-list", "max");
  revalidateTag("dataset", "max");
  revalidateTag("stats", "max");
  revalidateTag(`title-${hashtag}`, "max");
  revalidateTag(`similar-${hashtag}`, "max");
}

export async function POST(req: Request) {
  let body: { input?: string; persist?: boolean; scraped?: ScrapeResult };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.scraped && body.persist !== false) {
    try {
      const saved = await upsertScrapedTitle(body.scraped);
      invalidateAfterUpsert(body.scraped.hashtag);
      return NextResponse.json({ scraped: body.scraped, saved });
    } catch (e) {
      console.error("commit failed:", e);
      return NextResponse.json({ error: "Internal commit error" }, { status: 500 });
    }
  }

  const input = body.input?.trim();
  if (!input) {
    return NextResponse.json({ error: "Missing 'input' field" }, { status: 400 });
  }

  // Try the configured scraper hosts in order. SCRAPER_SERVICE_URL is the
  // primary — point it at the local ngrok box, whose residential IP lets impit's
  // fast path pass Cloudflare (~200ms). SCRAPER_SERVICE_URL_FALLBACK (Render) is
  // used only when the primary is unreachable (Mac asleep / tunnel down), where
  // every scrape pays the slow browser fallback.
  const hosts = [process.env.SCRAPER_SERVICE_URL, process.env.SCRAPER_SERVICE_URL_FALLBACK]
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u));

  if (hosts.length > 0) {
    let lastError: NextResponse = NextResponse.json(
      { error: "Scraper service unreachable" },
      { status: 503 },
    );
    for (let i = 0; i < hosts.length; i++) {
      const timeout = i === hosts.length - 1 ? SCRAPER_FALLBACK_TIMEOUT_MS : SCRAPER_PRIMARY_TIMEOUT_MS;
      const result = await callScraper(hosts[i], input, timeout);

      if (result.kind === "answered") {
        // Reachable host gave a verdict about the input itself — authoritative.
        return NextResponse.json(result.data, { status: result.status });
      }
      if (result.kind === "unreachable") {
        lastError = result.response;
        continue;
      }
      const { scraped, via } = result;
      if (!scraped) {
        lastError = NextResponse.json({ error: "Scraper service returned no data" }, { status: 502 });
        continue;
      }
      if (body.persist === false) return NextResponse.json({ scraped, via });
      const saved = await upsertScrapedTitle(scraped);
      invalidateAfterUpsert(scraped.hashtag);
      return NextResponse.json({ scraped, saved, via });
    }
    return lastError;
  }

  try {
    const { scraped, via } = await scrapeTitle(input);
    if (body.persist === false) {
      return NextResponse.json({ scraped, via });
    }
    const saved = await upsertScrapedTitle(scraped);
    invalidateAfterUpsert(scraped.hashtag);
    return NextResponse.json({ scraped, saved, via });
  } catch (e) {
    if (e instanceof ScrapeError) {
      const status = e.code === "BAD_INPUT" ? 400 : e.code === "NOT_FOUND" ? 404 : 502;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("scrape failed:", e);
    return NextResponse.json({ error: "Internal scrape error" }, { status: 500 });
  }
}
