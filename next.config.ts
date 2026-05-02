import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-extra", "puppeteer-extra-plugin-stealth"],
};

export default nextConfig;
