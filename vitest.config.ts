import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pierreStub = fileURLToPath(
  new URL("./src/features/source-control/testing/pierreStub.ts", import.meta.url),
);
const pierreReactStub = fileURLToPath(
  new URL("./src/features/source-control/testing/pierreReactStub.tsx", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [
      // Unit tests must not load the real diff package. tests/browser does.
      // The react subpath is first so the package prefix does not swallow it.
      { find: "@pierre/diffs/react", replacement: pierreReactStub },
      { find: /^@pierre\/diffs$/, replacement: pierreStub },
    ],
  },
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
