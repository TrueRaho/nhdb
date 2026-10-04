import type { NextConfig } from "next";

// Cover hosts, one entry per supported site. This list must equal the union of
// SOURCES[*].imageHosts in lib/sources.ts — the scrape write boundary refuses
// any cover outside those, so everything stored is something the optimizer
// will serve. lib/sources.test.ts fails if the two drift apart. (Written out
// rather than imported: module resolution in next.config.ts is limited — see
// node_modules/next/dist/docs/01-app/03-api-reference/05-config/02-typescript.md.)
//
// port is pinned empty (when omitted, `**` is implied and the optimizer would
// fetch any port on these hosts). search is left open, as it always was for
// nhentai: a CDN that appends a cache-busting query must not break covers.
const COVER_HOSTS = [
  "*.nhentai.net",                   // nhentai: t.nhentai.net, t1–t7, i, i1–i5
  "ehgt.org", "*.ehgt.org",          // E-Hentai thumbnails
  "*.gold-usergeneratedcontent.net", // Hitomi thumbnails (tn.…)
  "*.hitomi.la",
  "*.hentaifox.com",                 // i.hentaifox.com, i2…
  "*.imhentai.xxx",                  // m1–m10.imhentai.xxx
  "*.pururin.me",
  "*.hentaicdn.com",                 // Hentai2Read: static.hentaicdn.com
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-extra", "puppeteer-extra-plugin-stealth", "impit"],
  cacheComponents: true,
  images: {
    remotePatterns: COVER_HOSTS.map((hostname) => ({ protocol: "https", hostname, port: "" })),
  },
};

export default nextConfig;
