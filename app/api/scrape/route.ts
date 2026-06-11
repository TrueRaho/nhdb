import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { scrapeTitle, ScrapeError, type ScrapeResult } from "@/lib/scraper";
import { upsertScrapedTitle } from "@/lib/titles";

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

  const scraperUrl = process.env.SCRAPER_SERVICE_URL;
  if (scraperUrl) {
    let upstream: Response;
    try {
      upstream = await fetch(`${scraperUrl.replace(/\/$/, "")}/scrape`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.SCRAPER_SECRET
            ? { Authorization: `Bearer ${process.env.SCRAPER_SECRET}` }
            : {}),
        },
        body: JSON.stringify({ input }),
      });
    } catch {
      return NextResponse.json({ error: "Scraper service unreachable" }, { status: 503 });
    }
    // ngrok/proxies return HTML error pages when the tunnel is down — don't 500 on them
    let upstreamData: { scraped?: ScrapeResult; error?: string };
    try {
      upstreamData = await upstream.json();
    } catch {
      return NextResponse.json(
        { error: `Scraper service returned an invalid response (HTTP ${upstream.status}) — is the tunnel up?` },
        { status: 502 },
      );
    }
    if (!upstream.ok) return NextResponse.json(upstreamData, { status: upstream.status });
    const { scraped } = upstreamData;
    if (!scraped) {
      return NextResponse.json({ error: "Scraper service returned no data" }, { status: 502 });
    }
    if (body.persist === false) return NextResponse.json({ scraped });
    const saved = await upsertScrapedTitle(scraped);
    invalidateAfterUpsert(scraped.hashtag);
    return NextResponse.json({ scraped, saved });
  }

  try {
    const scraped = await scrapeTitle(input);
    if (body.persist === false) {
      return NextResponse.json({ scraped });
    }
    const saved = await upsertScrapedTitle(scraped);
    invalidateAfterUpsert(scraped.hashtag);
    return NextResponse.json({ scraped, saved });
  } catch (e) {
    if (e instanceof ScrapeError) {
      const status = e.code === "BAD_INPUT" ? 400 : e.code === "NOT_FOUND" ? 404 : 502;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("scrape failed:", e);
    return NextResponse.json({ error: "Internal scrape error" }, { status: 500 });
  }
}
