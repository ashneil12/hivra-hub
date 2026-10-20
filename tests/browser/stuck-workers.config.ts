import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import { fileURLToPath } from "node:url";

// The stuck-workers proof on its own port and in Chromium only, so it runs beside other worktrees' browser tests:
// npx playwright test -c tests/browser/stuck-workers.config.ts
const PORT = Number(process.env.STUCK_PROOF_PORT ?? 1497);

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "stuck-workers.spec.ts",
  timeout: 120_000,
  use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/hub-dev.html`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
