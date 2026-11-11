import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import { fileURLToPath } from "node:url";

// G10: the hub's Inbox (one Needs you list with the first mate's decisions in it) only renders with the Hub flag, which
// the default browser config doesn't set. Same shape as hivra-layout.config.ts, on its own port:
//   npx playwright test -c tests/browser/inbox-one-list.config.ts
const PORT = Number(process.env.INBOX_ONE_LIST_PORT ?? 1543);

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "inbox-one-list.hub.ts",
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
