import http from "node:http";
import { spawn } from "node:child_process";
import { config } from "dotenv";
import { scrapeTitle, ScrapeError } from "./lib/scraper";

config({ path: ".env.local" });

const PORT = Number(process.env.SCRAPER_PORT ?? 3333);
const SECRET = process.env.SCRAPER_SECRET;

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/scrape") {
    res.writeHead(404).end();
    return;
  }

  if (SECRET && req.headers.authorization !== `Bearer ${SECRET}`) {
    res.writeHead(401, { "Content-Type": "application/json" })
       .end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  let input: string;
  try {
    ({ input } = JSON.parse(Buffer.concat(chunks).toString()));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" })
       .end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  try {
    const scraped = await scrapeTitle(input);
    res.writeHead(200, { "Content-Type": "application/json" })
       .end(JSON.stringify({ scraped }));
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

server.listen(PORT, () => {
  console.log(`Scraper listening on http://localhost:${PORT}`);

  const domain = process.env.NGROK_DOMAIN;
  const args = ["http", String(PORT), ...(domain ? ["--domain", domain] : [])];
  const ngrok = spawn("ngrok", args, { stdio: "inherit" });
  ngrok.on("error", () => console.error("ngrok not found — run: brew install ngrok"));
  process.on("SIGINT", () => { ngrok.kill(); process.exit(0); });
});
