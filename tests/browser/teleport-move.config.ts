import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import { fileURLToPath } from "node:url";

// WP-177: the chat-move panel on Chromium and WebKit, on its own port so it never fights another dev server.
// Run: npx playwright test -c tests/browser/teleport-move.config.ts
const PORT = Number(process.env.TELEPORT_PROOF_PORT ?? 1463);

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: ["teleport-move.spec.ts", "teleport-notice.spec.ts"],
  timeout: 120_000,
  use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}` },
  // The base chromium project (installed Chrome with the sandbox on, locally) and the base webkit project.
  projects: base.projects,
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/tests/browser/teleport-move.html`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
