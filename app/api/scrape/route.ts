import { NextResponse } from "next/server";
import { requireUserId, UnauthorizedError } from "@/lib/session";
import { consumeScrapeBudget } from "@/lib/rate-limit";
import { resolveScraperTargets, type ScraperTarget } from "@/lib/scraper-endpoints";
import { assertReachableHost, UnsafeUrlError } from "@/lib/net-guard";
import { titlesListTag, datasetTag, statsTag, titleTag, similarTag, similarAnyTag } from "@/lib/cache-tags";
import { revalidateTag } from "next/cache";
import { scrapeTitle, ScrapeError, type ScrapeVia } from "@/lib/scraper";
import { parseScrapePayload, scrapedRef, type ScrapeResult } from "@/lib/scrape-payload";
import { parseTitleRef, refKey, SOURCES, sourceUrl, type TitleRef } from "@/lib/sources";
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
  | { kind: "ok"; scraped: ScrapeResult; via: ScrapeVia }
  | { kind: "answered"; status: number; data: unknown }
  | { kind: "unreachable"; response: NextResponse };

// What a host is asked for: the canonical form of the title, never the text the
// user pasted. nhentai keeps the bare id every host version understands; the
// other sites go as their rebuilt gallery URL, which reads unambiguously in a
// host's logs.
function hostInput(ref: TitleRef): string {
  return ref.source === "nhentai" ? ref.id : sourceUrl(ref);
}

// Calls one scraper host. "answered" = reachable and gave a definitive verdict
// about the input (404/400) — don't retry elsewhere. "unreachable" = network
// error, timeout, HTML error page (tunnel down), or a non-input error — the
// caller should fall through to the next host.
async function callScraper(target: ScraperTarget, ref: TitleRef, timeoutMs: number): Promise<ScraperCall> {
  // Re-checked immediately before connecting, not just when the URL was saved:
  // a name that resolved to a public address at save time can resolve to
  // 127.0.0.1 now, and only the check next to the request sees that.
  try {
    await assertReachableHost(target.url);
  } catch (e) {
    return {
      kind: "unreachable",
      response: NextResponse.json(
        { error: e instanceof UnsafeUrlError ? e.message : "Scraper host is not reachable" },
        { status: 502 },
      ),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let upstream: Response;
  try {
    upstream = await fetch(`${target.url.replace(/\/$/, "")}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.secret ? { Authorization: `Bearer ${target.secret}` } : {}),
      },
      body: JSON.stringify({ input: hostInput(ref) }),
      signal: controller.signal,
      // The host is user-supplied, so a redirect is an SSRF bypass: the address
      // checks above apply to the URL we chose, and a 302 would send the next
      // request — bearer token attached — somewhere nobody validated.
      redirect: "error",
    });
  } catch {
    clearTimeout(timer);
    return {
      kind: "unreachable",
      response: NextResponse.json({ error: "Scraper service unreachable" }, { status: 503 }),
    };
  }

  // ngrok/proxies return HTML error pages when the tunnel is down — a JSON parse
  // failure means "not a real scraper response", so fall through to the next host.
  // The abort timer stays armed through the body read: headers can arrive fast
  // while the body stalls, and an undisarmed abort makes json() reject so we
  // fall through to the next host instead of hanging until maxDuration.
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
  } finally {
    clearTimeout(timer);
  }

  // A host is the user's own machine running whatever version (or edit) of the
  // scraper they have, so its answer is checked like any other untrusted
  // payload before it is shown, let alone stored — and it has to be the title
  // that was asked for. A host that fails either check is treated as broken,
  // and the next one gets its turn.
  if (upstream.ok) {
    let scraped: ScrapeResult;
    try {
      scraped = parseScrapePayload(data.scraped);
    } catch (e) {
      return {
        kind: "unreachable",
        response: NextResponse.json(
          { error: `Scraper host returned an unusable title: ${e instanceof Error ? e.message : "invalid"}` },
          { status: 502 },
        ),
      };
    }
    if (refKey(scrapedRef(scraped)) !== refKey(ref)) {
      return {
        kind: "unreachable",
        response: NextResponse.json({ error: "Scraper host returned a different title" }, { status: 502 }),
      };
    }
    return { kind: "ok", scraped, via: data.via === "fallback" ? "fallback" : "impit" };
  }
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
function invalidateAfterUpsert(userId: string, hashtag: number) {
  revalidateTag(titlesListTag(userId), "max");
  revalidateTag(datasetTag(userId), "max");
  revalidateTag(statsTag(userId), "max");
  revalidateTag(titleTag(userId, hashtag), "max");
  revalidateTag(similarTag(userId, hashtag), "max");
  // Broad tag: neighbors' similar-<other> lists (tag overlap) reference this
  // title too and would otherwise go stale forever.
  revalidateTag(similarAnyTag(userId), "max");
}

// upsertScrapedTitle validates the payload at the write boundary and throws a
// named validation error on malformed input — map those to 400, not 500.
function isValidationError(e: unknown): e is Error {
  return e instanceof Error && /invalid|validation/i.test(e.name);
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("session lookup failed:", error);
    return NextResponse.json({ error: "Authentication unavailable" }, { status: 503 });
  }
  let body: { input?: string; persist?: boolean; scraped?: ScrapeResult };
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    body = parsed;
    if ((body.input !== undefined && typeof body.input !== "string") ||
        (body.persist !== undefined && typeof body.persist !== "boolean")) {
      return NextResponse.json({ error: "Invalid input or persist field" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.scraped && body.persist !== false) {
    try {
      const saved = await upsertScrapedTitle(userId, body.scraped);
      invalidateAfterUpsert(userId, saved.hashtag);
      return NextResponse.json({ scraped: body.scraped, saved });
    } catch (e) {
      if (isValidationError(e)) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      console.error("commit failed:", e);
      return NextResponse.json({ error: "Internal commit error" }, { status: 500 });
    }
  }

  const input = body.input?.trim();
  if (!input) {
    return NextResponse.json({ error: "Missing 'input' field" }, { status: 400 });
  }
  // Only a title from a supported site is ever scraped: a search page, a tag
  // page or a link to anywhere else stops here — before the budget is charged
  // and before any host is contacted (lib/sources.ts is the allow-list).
  const ref = parseTitleRef(input);
  if (!ref) {
    return NextResponse.json(
      { error: "Not a title link from a supported site", code: "BAD_INPUT" },
      { status: 400 },
    );
  }

  // The scraper is per user: everyone registers their own hosts on /account, in
  // priority order. Position 0 should be the fast one (a local box behind a
  // tunnel, whose residential IP lets impit's ~200ms path pass Cloudflare); the
  // rest are tried only when it is unreachable and typically pay the slow
  // browser fallback.
  //
  // The env vars remain as a DEVELOPMENT-only default so `pnpm dev` works
  // against a local `pnpm scraper` with no setup. In production they are
  // ignored: a shared fallback host would quietly put everyone's scraping back
  // on one person's box, which is the thing per-user endpoints exist to stop.
  const hosts: ScraperTarget[] = await resolveScraperTargets(userId);
  if (hosts.length === 0 && process.env.NODE_ENV !== "production") {
    for (const url of [process.env.SCRAPER_SERVICE_URL, process.env.SCRAPER_SERVICE_URL_FALLBACK]) {
      const trimmed = url?.trim();
      if (trimmed) hosts.push({ url: trimmed, secret: process.env.SCRAPER_SECRET ?? null, label: "env" });
    }
  }

  // Answered before the budget is charged: an account with nothing configured
  // is a setup problem, and spending one of the user's hourly scrapes to tell
  // them so would be a small, confusing theft.
  if (hosts.length === 0 && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "No scraper host configured. Add one in Account settings." },
      { status: 409 },
    );
  }

  // Charged here rather than at the top of the handler: everything above this
  // point is a database write the caller makes to their own rows, while
  // everything below spends real resources — the user's scraper, and a
  // serverless function held open for up to maxDuration. So a `persist` commit
  // of an already-scraped payload costs nothing, and a malformed request costs
  // nothing.
  const budget = await consumeScrapeBudget(userId);
  if (!budget.allowed) {
    return NextResponse.json(
      { error: `Scrape limit reached (${budget.limit}/hour). Try again later.` },
      { status: 429, headers: { "Retry-After": String(budget.retryAfterSeconds) } },
    );
  }

  if (hosts.length > 0) {
    let lastError: NextResponse = NextResponse.json(
      { error: "Scraper service unreachable" },
      { status: 503 },
    );
    for (let i = 0; i < hosts.length; i++) {
      const timeout = i === hosts.length - 1 ? SCRAPER_FALLBACK_TIMEOUT_MS : SCRAPER_PRIMARY_TIMEOUT_MS;
      const result = await callScraper(hosts[i], ref, timeout);

      if (result.kind === "answered") {
        // A 400 about a well-formed link from another site means the host
        // does not know that site — a scraper from before multi-site support.
        // Say so, and let a newer host further down the list try.
        if (result.status === 400 && ref.source !== "nhentai") {
          lastError = NextResponse.json(
            {
              error: `Your scraper host (${hosts[i].label || "host"}) could not read this ${SOURCES[ref.source].name} ` +
                "link — it is probably running an older version. Update it and try again.",
              code: "BAD_INPUT",
            },
            { status: 400 },
          );
          continue;
        }
        // Reachable host gave a verdict about the input itself — authoritative.
        return NextResponse.json(result.data, { status: result.status });
      }
      if (result.kind === "unreachable") {
        lastError = result.response;
        continue;
      }
      const { scraped, via } = result;
      if (body.persist === false) return NextResponse.json({ scraped, via });
      try {
        const saved = await upsertScrapedTitle(userId, scraped);
        invalidateAfterUpsert(userId, saved.hashtag);
        return NextResponse.json({ scraped, saved, via });
      } catch (e) {
        if (isValidationError(e)) {
          return NextResponse.json({ error: e.message }, { status: 400 });
        }
        console.error("persist failed:", e);
        return NextResponse.json({ error: "Internal persist error" }, { status: 500 });
      }
    }
    return lastError;
  }

  try {
    const { scraped, via } = await scrapeTitle(ref);
    if (body.persist === false) {
      return NextResponse.json({ scraped, via });
    }
    const saved = await upsertScrapedTitle(userId, scraped);
    invalidateAfterUpsert(userId, saved.hashtag);
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
