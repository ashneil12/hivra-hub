import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1435",
    viewport: { width: 1000, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [
    // Local runs use the installed, auto-updating Google Chrome with its sandbox on: Playwright's bundled Chromium
    // lags Chrome's security fixes and runs with --no-sandbox unless chromiumSandbox is true. CI installs the pinned
    // build fresh (`playwright install chromium`) and has no Google Chrome, so it keeps Playwright's defaults.
    {
      name: "chromium",
      use: { browserName: "chromium", ...(process.env.CI ? {} : { channel: "chrome", chromiumSandbox: true }) },
    },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1435",
    url: "http://127.0.0.1:1435/tests/browser/transcript.html",
    reuseExistingServer: false,
  },
});
