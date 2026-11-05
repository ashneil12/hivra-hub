import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // A busy Mac (load 30+) stretches dynamic imports and renders past 5 s; a real hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
