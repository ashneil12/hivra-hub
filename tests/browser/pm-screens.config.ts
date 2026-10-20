import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import { fileURLToPath } from "node:url";

// The PM screens proof (B6 stuck panel, A9 folded Monos) on its own port. Uses an installed Chrome when Playwright's own
// Chromium isn't downloaded (PM_PROOF_CHANNEL=chrome, the default here): npx playwright test -c tests/browser/pm-screens.config.ts
const PORT = Number(process.env.PM_PROOF_PORT ?? 1531);
const channel = process.env.PM_PROOF_CHANNEL ?? "chrome";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "pm-screens.spec.ts",
  timeout: 120_000,
  use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: "chromium", use: { browserName: "chromium", ...(channel ? { channel } : {}) } }],
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/hub-dev.html`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
