import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Default environment is plain node (pure logic, route handlers). Component
// tests opt into jsdom per file via a `// @vitest-environment jsdom` docblock
// — no global jsdom, no React plugin, nothing to keep in sync with Next.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "lib/generated/**"],
  },
  resolve: {
    // Mirrors the "@/*" path alias in tsconfig.json.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
