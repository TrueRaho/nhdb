import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Serve the checked-in instructions so the account link works on deployments
// too, without assuming the private repository is accessible to the caller.
export async function GET() {
  return new Response(await readFile(join(process.cwd(), "SCRAPER.md"), "utf8"), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}
