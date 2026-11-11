import { defineConfig } from "@playwright/test";

// Hub fork: every page starts as an app that has finished first launch. The Hub's onboarding card and its setup card
// would otherwise cover the fixture page on a fresh profile. Specs that test onboarding open it with `?onboarding`
// (see src/features/hub/model/onboarding.ts) or clear these keys themselves. The app's own gate is unchanged.
// PW_PORT lets a run use a free port when another dev server holds 1435.
const PORT = Number(process.env.PW_PORT ?? 1435);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FINISHED_FIRST_LAUNCH = {
  cookies: [],
  origins: [
    {
      origin: BASE_URL,
      localStorage: [
        { name: "monocode:hub-onboarded", value: "1" },
        { name: "monocode:hub-setup-not-now", value: "1" },
      ],
    },
  ],
};

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {
    baseURL: BASE_URL,
    storageState: FINISHED_FIRST_LAUNCH,
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
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT}`,
    url: `${BASE_URL}/tests/browser/transcript.html`,
    reuseExistingServer: false,
  },
});
