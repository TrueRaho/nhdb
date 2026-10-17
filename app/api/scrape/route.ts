import { NextResponse } from "next/server";
import { NO_SCRAPER_HOST, NO_SCRAPER_HOST_MESSAGE } from "../../../lib/scraper-config";
import { requireUserId, UnauthorizedError } from "@/lib/session";
import { consumeScrapeBudget } from "@/lib/rate-limit";
import { UsageLimitError } from "@/lib/usage-limits";
import { resolveScraperTargets, type ScraperTarget } from "@/lib/scraper-endpoints";
import { assertReachableHost, UnsafeUrlError } from "@/lib/net-guard";
import { fetchPublic } from "@/lib/public-fetch";
import { readCapped } from "@/lib/read-capped";
import { titlesListTag, datasetTag, statsTag, titleTag, similarTag, similarAnyTag } from "@/lib/cache-tags";
import { revalidateTag } from "next/cache";
import { scrapeTitle, ScrapeError, type ScrapeVia } from "@/lib/scraper";
import { parseScrapePayload, scrapedRef, type ScrapeResult } from "@/lib/scrape-payload";
import { parseTitleRef, refKey, siteName, type TitleRef } from "@/lib/sources";
import { upsertScrapedTitle } from "@/lib/titles";

// The proxied browser fallback (esp. on Render) can take ~15-30s; let the
// function wait it out instead of the platform's short default timeout.
export const maxDuration = 60;

// Per-host timeouts so a sleeping primary can't eat the whole 60s budget before
// the fallback gets its turn. The local box is fast (impit ~200ms); Render's
// warm browser fallback runs ~15-30s.
const SCRAPER_PRIMARY_TIMEOUT_MS = 12_000;
const SCRAPER_FALLBACK_TIMEOUT_MS = 45_000;
const SCRAPE_DEADLINE_MS = 50_000;
const MAX_HOST_BYTES = 2 * 1024 * 1024;

type HostError = { error: string; code?: string; reads?: "any-site" };

function hostError(data: Record<string, unknown>): HostError {
  let error = "Scraper service failed";
  // JSON can contain an object whose own toString/valueOf prevent coercion.
  try { error = String(data.error ?? error); } catch { /* keep the default */ }
  return {
    error: error.slice(0, 500),
    ...(typeof data.code === "string" ? { code: data.code.slice(0, 64) } : {}),
    ...(data.reads === "any-site" ? { reads: "any-site" as const } : {}),
  };
}

type ScraperCall =
  | { kind: "ok"; scraped: ScrapeResult; via: ScrapeVia }
  | { kind: "answered"; status: number; data: HostError }
  | { kind: "unreachable"; response: NextResponse };

// What a host is asked for: the title's page address as parsed here, never
// the text the user pasted. nhentai keeps the bare id every host version
// understands.
function hostInput(ref: TitleRef): string {
  return ref.source === "nhentai" ? ref.id : ref.url;
}

// Calls one scraper host. "answered" = reachable and gave a definitive verdict
// about the input (404/400) — don't retry elsewhere. "unreachable" = network
// error, timeout, HTML error page (tunnel down), or a non-input error — the
// caller should fall through to the next host.
async function callScraper(target: ScraperTarget, ref: TitleRef, timeoutMs: number): Promise<ScraperCall> {
  const controller = new AbortController();
  const timedOut = new Promise<ScraperCall>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve({
      kind: "unreachable",
      response: NextResponse.json({ error: "Scraper service timed out" }, { status: 503 }),
    }), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // DNS itself is not abortable. Race the entire attempt, and check the signal
    // after DNS so a late lookup cannot start a fetch after this attempt ended.
    return await Promise.race([readScraper(target, ref, controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function readScraper(target: ScraperTarget, ref: TitleRef, signal: AbortSignal): Promise<ScraperCall> {
  // Keep the URL/save-time guard; the dispatcher independently validates and
  // pins DNS at connection time, closing the gap after this preflight check.
  try {
    await assertReachableHost(target.url);
    signal.throwIfAborted();
  } catch (e) {
    return {
      kind: "unreachable",
      response: NextResponse.json(
        { error: e instanceof UnsafeUrlError ? e.message : "Scraper host is not reachable" },
        { status: 502 },
      ),
    };
  }

  let upstream: Response;
  try {
    upstream = await fetchPublic(`${target.url.replace(/\/$/, "")}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.secret ? { Authorization: `Bearer ${target.secret}` } : {}),
      },
      body: JSON.stringify({ input: hostInput(ref) }),
      signal,
      // The host is user-supplied, so a redirect is an SSRF bypass: the address
      // checks above apply to the URL we chose, and a 302 would send the next
      // request — bearer token attached — somewhere nobody validated.
      redirect: "error",
    }, true);
  } catch {
    return {
      kind: "unreachable",
      response: NextResponse.json({ error: "Scraper service unreachable" }, { status: 503 }),
    };
  }

  // ngrok/proxies return HTML error pages when the tunnel is down — a JSON parse
  // failure means "not a real scraper response", so fall through to the next host.
  // The abort timer stays armed through the body read: headers can arrive fast
  // while the body stalls, and an undisarmed abort makes the read reject so we
  // fall through to the next host instead of hanging until maxDuration.
  let data: Record<string, unknown>;
  try {
    // Node fetch decompresses gzip/br before exposing this stream. Never trust
    // Content-Length (which may describe only a tiny compressed body).
    const bytes = await readCapped(upstream, MAX_HOST_BYTES);
    if (!bytes) {
      return {
        kind: "unreachable",
        response: NextResponse.json({ error: "Scraper service response is too large" }, { status: 502 }),
      };
    }
    signal.throwIfAborted();
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
    data = parsed as Record<string, unknown>;
  } catch {
    return {
      kind: "unreachable",
      response: NextResponse.json(
        { error: `Scraper service returned an invalid response (HTTP ${upstream.status})` },
        { status: 502 },
      ),
    };
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
    return { kind: "answered", status: upstream.status, data: hostError(data) };
  }
  return {
    kind: "unreachable",
    response: NextResponse.json(hostError(data), { status: upstream.status }),
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

function quotaResponse(error: UsageLimitError) {
  return NextResponse.json({ error: error.message }, {
    status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) },
  });
}

export async function POST(req: Request) {
  // Authentication/setup time also spends this allowance; leave ten seconds
  // under maxDuration for validation and persistence after outbound work.
  const deadline = Date.now() + SCRAPE_DEADLINE_MS;
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
      if (e instanceof UsageLimitError) return quotaResponse(e);
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
  // Only an address that looks like ONE title's is scraped: a home page, a
  // search, a tag list or anything that is not a link stops here — before the
  // budget is charged and before any host is contacted (lib/sources.ts). Whether
  // the page really is a title is for the scraper to read.
  const ref = parseTitleRef(input);
  if (!ref) {
    return NextResponse.json(
      { error: "Not a link to a title", code: "BAD_INPUT" },
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
      { error: NO_SCRAPER_HOST_MESSAGE, code: NO_SCRAPER_HOST },
      { status: 409 },
    );
  }

  // Charged here rather than at the top of the handler: everything above this
  // point can commit an existing payload; that spends only the separate
  // new-title budget at the shared write boundary. Everything below reaches
  // the scraper and spends the scrape budget, even when no title is saved.
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
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const timeout = i === hosts.length - 1 ? SCRAPER_FALLBACK_TIMEOUT_MS : SCRAPER_PRIMARY_TIMEOUT_MS;
      const result = await callScraper(hosts[i], ref, Math.min(timeout, remaining));

      if (result.kind === "answered") {
        // A 400 about a link this app accepted, from a host that does not say
        // it reads any site, means a scraper from before it could. Say so, and
        // let a newer host further down the list try. A current host's 400 is
        // its verdict (a site resolving into a private network, say) and stands.
        const readsAnySite = result.data.reads === "any-site";
        if (result.status === 400 && ref.source !== "nhentai" && !readsAnySite) {
          lastError = NextResponse.json(
            {
              error: `Your scraper host (${hosts[i].label || "host"}) could not read this ${siteName(ref.source)} ` +
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
        if (e instanceof UsageLimitError) return quotaResponse(e);
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
    if (e instanceof UsageLimitError) return quotaResponse(e);
    if (e instanceof ScrapeError) {
      const status = e.code === "BAD_INPUT" ? 400 : e.code === "NOT_FOUND" ? 404 : 502;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error("scrape failed:", e);
    return NextResponse.json({ error: "Internal scrape error" }, { status: 500 });
  }
}
