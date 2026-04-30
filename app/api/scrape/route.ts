import { NextResponse } from "next/server";
import { scrapeTitle, ScrapeError } from "@/app/lib/scraper";
import { upsertScrapedTitle } from "@/app/lib/titles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { input?: string; persist?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body.input?.trim();
  if (!input) {
    return NextResponse.json({ error: "Missing 'input' field" }, { status: 400 });
  }

  try {
    const scraped = await scrapeTitle(input);
    if (body.persist === false) {
      return NextResponse.json({ scraped });
    }
    const saved = await upsertScrapedTitle(scraped);
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
