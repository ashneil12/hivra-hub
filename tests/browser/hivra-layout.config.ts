import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import { fileURLToPath } from "node:url";

// WP-03: Hivra's one layout, in the real app in a browser built the way Hivra is (VITE_MONOCODE_HUB=1, which the
// default browser config doesn't set), on its own port, in both engines:
//   npx playwright test -c tests/browser/hivra-layout.config.ts
// The spec is named *.hub.ts so the default config (no Hub flag) doesn't pick it up.
const PORT = Number(process.env.HIVRA_LAYOUT_PORT ?? 1541);

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "hivra-layout.hub.ts",
  timeout: 120_000,
  use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    env: { VITE_MONOCODE_HUB: "1" },
    url: `http://127.0.0.1:${PORT}/hub-dev.html`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
