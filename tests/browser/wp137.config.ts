import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import { fileURLToPath } from "node:url";

// WP-137's spec on its own port (several builders share a Mac, and the default config's port may be taken), in
// Chromium and WebKit, with the shared config's finished-first-launch storage moved to this port:
//   npx playwright test -c tests/browser/wp137.config.ts
const PORT = Number(process.env.WP137_PORT ?? 1557);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const storage = base.use?.storageState;
const origins = typeof storage === "object" && storage ? storage.origins : [];

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "wp137-spaces.spec.ts",
  timeout: 120_000,
  use: {
    ...base.use,
    baseURL: BASE_URL,
    storageState: { cookies: [], origins: origins.map((origin) => ({ ...origin, origin: BASE_URL })) },
  },
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `${BASE_URL}/hub-dev.html`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
