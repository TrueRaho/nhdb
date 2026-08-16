import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { config } from "dotenv";
import { scrapeTitle, ScrapeError, closeScraper } from "../lib/scraper";

config({ path: [".env.local", ".env"] });

// Render injects PORT; locally fall back to SCRAPER_PORT or 3333.
const PORT = Number(process.env.PORT ?? process.env.SCRAPER_PORT ?? 3333);
const SECRET = process.env.SCRAPER_SECRET;

// The scrape payload is a single short input string — anything near this cap
// is abuse, and buffering unbounded bodies would let a client exhaust memory.
const MAX_BODY_BYTES = 64 * 1024;

// Constant-time bearer-token check (a plain !== compare leaks the match
// length/prefix through timing). Unequal lengths short-circuit — that only
// reveals the token's length, not its content.
function isAuthorized(header: string | undefined): boolean {
  if (!SECRET) return true;
  const expected = Buffer.from(`Bearer ${SECRET}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const server = http.createServer(async (req, res) => {
  // Health check — Render pings this, and it's a quick "is the tunnel up?" probe.
  // Kept before the auth check so the platform can reach it without the secret.
  if (req.method === "GET" && (req.url === "/" || req.url === "/healthz")) {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/scrape") {
    res.writeHead(404).end();
    return;
  }

  if (!isAuthorized(req.headers.authorization)) {
    res.writeHead(401, { "Content-Type": "application/json" })
       .end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // The body read MUST be inside try/catch: a connection reset mid-body (ngrok
  // tunnel flap, client killed mid-upload) rejects the async iterator, and an
  // unhandled rejection in this async handler kills the whole process — taking
  // the warm browser down and orphaning the ngrok child on its reserved domain.
  const chunks: Buffer[] = [];
  try {
    let received = 0;
    for await (const chunk of req) {
      received += (chunk as Buffer).length;
      if (received > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" })
           .end(JSON.stringify({ error: "Request body too large" }));
        return;
      }
      chunks.push(chunk as Buffer);
    }
  } catch {
    // The socket is usually already gone — just make sure the response dies too.
    if (!res.writableEnded) res.destroy();
    return;
  }
  let input: string;
  try {
    ({ input } = JSON.parse(Buffer.concat(chunks).toString()));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" })
       .end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  try {
    const { scraped, via } = await scrapeTitle(input);
    res.writeHead(200, { "Content-Type": "application/json" })
       .end(JSON.stringify({ scraped, via }));
  } catch (e) {
    if (e instanceof ScrapeError) {
      const status = e.code === "BAD_INPUT" ? 400 : e.code === "NOT_FOUND" ? 404 : 502;
      res.writeHead(status, { "Content-Type": "application/json" })
         .end(JSON.stringify({ error: e.message, code: e.code }));
    } else {
      console.error("scrape failed:", e);
      res.writeHead(500, { "Content-Type": "application/json" })
         .end(JSON.stringify({ error: "Internal scrape error" }));
    }
  }
});

// On Render the platform gives a public HTTPS URL, so ngrok is neither needed
// nor available — RENDER is set there automatically. Locally we tunnel through
// ngrok unless explicitly disabled.
const useNgrok = !process.env.RENDER && process.env.DISABLE_NGROK !== "1";
let ngrok: ChildProcess | undefined;

// Refuse to expose an unauthenticated scraper. isAuthorized() is a no-op when
// SCRAPER_SECRET is unset, which is fine on a localhost-only server but
// fail-open the moment a public URL exists (Render, or the ngrok tunnel).
// SECURITY.md documents the secret as the service's only protection.
if (!SECRET && (process.env.RENDER || useNgrok)) {
  console.error(
    "SCRAPER_SECRET is not set but the server would be publicly reachable " +
    "(Render or ngrok). Set SCRAPER_SECRET, or run local-only with DISABLE_NGROK=1.",
  );
  process.exit(1);
}

// Belt to the try/catch's suspenders: no future rejection on some handler path
// may kill the host — a dead primary silently sends every scrape to the slow
// Render fallback, and the orphaned ngrok child blocks the reserved domain.
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Scraper listening on port ${PORT}`);

  if (useNgrok) {
    const domain = process.env.NGROK_DOMAIN;
    const args = ["http", String(PORT), ...(domain ? ["--domain", domain] : [])];
    ngrok = spawn("ngrok", args, { stdio: "inherit" });
    ngrok.on("error", () => console.error("ngrok not found — run: brew install ngrok"));
    // A tunnel that dies (auth expiry, agent crash) leaves the server running
    // but unreachable from Vercel — say so loudly instead of failing silently.
    ngrok.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`ngrok exited with code ${code}${signal ? ` (${signal})` : ""} — tunnel is DOWN, restart the server`);
      }
    });
  }
});

// Render sends SIGTERM on deploy/stop; close the warm browser cleanly either way.
function shutdown() {
  ngrok?.kill();
  server.close();
  void closeScraper().finally(() => process.exit(0));
  // A hung browser.close() must not wedge the process — force-exit after 5s.
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
