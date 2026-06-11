import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-extra", "puppeteer-extra-plugin-stealth"],
  cacheComponents: true,
  images: {
    // covers t.nhentai.net, t1–t7, i, i1–i5 — any single-label subdomain
    remotePatterns: [{ protocol: "https", hostname: "*.nhentai.net" }],
  },
};

export default nextConfig;
