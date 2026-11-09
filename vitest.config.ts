import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // WP-105: a test that reaches the network or writes into the app's real data folders fails (see
    // src/test/harnessSetup.ts). allowNetworkForThisTest() opts one test out.
    setupFiles: ["src/test/harnessSetup.ts"],
    // A busy Mac (load 30+) stretches dynamic imports and renders past 5 s; a real hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
