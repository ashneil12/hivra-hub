import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import { fileURLToPath } from "node:url";

// A browser proof on its own port and in Chromium only, so it runs beside other worktrees' browser tests.
// WP-06 retired stuck-workers.spec.ts with Being built. The default is the coding team, which replaced that home.
// npx playwright test -c tests/browser/stuck-workers.config.ts (PROOF_SPEC=agents-page.spec.ts runs another spec this way)
const PORT = Number(process.env.STUCK_PROOF_PORT ?? 1497);

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: process.env.PROOF_SPEC ?? "coding-team.spec.ts",
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
