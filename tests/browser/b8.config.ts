import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import { fileURLToPath } from "node:url";

// B8 (conversations: new-conversation screen, rename, attachments) in the real app in WebKit, the Mac app's engine, on
// its own port: npx playwright test -c tests/browser/b8.config.ts
const PORT = Number(process.env.B8_PROOF_PORT ?? 1531);

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "b8-conversations.spec.ts",
  timeout: 120_000,
  use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: "webkit", use: { browserName: "webkit" } }],
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/hub-dev.html`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
