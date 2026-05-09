import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-extra", "puppeteer-extra-plugin-stealth"],
  cacheComponents: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "t.nhentai.net" },
      { protocol: "https", hostname: "t1.nhentai.net" },
      { protocol: "https", hostname: "t2.nhentai.net" },
      { protocol: "https", hostname: "t3.nhentai.net" },
      { protocol: "https", hostname: "t4.nhentai.net" },
      { protocol: "https", hostname: "t5.nhentai.net" },
      { protocol: "https", hostname: "t6.nhentai.net" },
      { protocol: "https", hostname: "t7.nhentai.net" },
      { protocol: "https", hostname: "i.nhentai.net" },
      { protocol: "https", hostname: "i1.nhentai.net" },
      { protocol: "https", hostname: "i2.nhentai.net" },
      { protocol: "https", hostname: "i3.nhentai.net" },
      { protocol: "https", hostname: "i4.nhentai.net" },
      { protocol: "https", hostname: "i5.nhentai.net" },
    ],
  },
};

export default nextConfig;
