import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// WP-20's first-launch proof, on its own port, in Chromium and WebKit.
// A fresh profile: the shared config's storage marks first launch finished, which would hide this card.
const PORT = Number(process.env.WP20_PORT ?? 1547);

export default defineConfig({
  testDir: ".",
  testMatch: "wp20-coding-team.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [], origins: [] },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium", ...(process.env.CI ? {} : { channel: "chrome" }) } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/hub-dev.html`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
