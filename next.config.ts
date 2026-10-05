import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-extra", "puppeteer-extra-plugin-stealth", "impit"],
  cacheComponents: true,
  images: {
    // Every cover is loaded through the same-origin proxy /api/cover, never from
    // the site's CDN directly: some CDNs serve only requests carrying their own
    // site's Referer, which neither the browser nor the optimizer can send (the
    // optimizer forwards no headers — not the Referer, not the session cookie
    // the proxy checks). So nothing here is optimized, and with no
    // remotePatterns the optimizer is not a second way to fetch those hosts.
    // (Each cover <Image> also says `unoptimized` itself, so it keeps working
    // if this default changes.) The cover allow-list is SOURCES[*].imageHosts
    // in lib/sources.ts.
    unoptimized: true,
  },
};

export default nextConfig;
