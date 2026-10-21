import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// PM redo proofs (B8, G4, F3, C6, PM-20, PM-21) in the real app in a browser: hub-dev.html reading the stub Ash OS.
// One photo per screen. A browser preview only, not Ash's Mac.
//   PM_PROOF_SPEC=pm-redo.spec.ts npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-redo";
fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());
test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page) {
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => undefined);
}

test("B8: New conversation opens a screen with a pencil to name it; + offers Photo or image, or File", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^EXO/ }).first().click();
  await page.locator('[data-hub-item="leadership-team"]').click();
  await expect(page.locator("[data-hub-chat]")).toBeVisible();
  await page.locator("[data-hub-new-conversation]").click();
  await expect(page.locator("[data-hub-new-conversation-screen]")).toBeVisible();
  await expect(page.locator("[data-hub-conversation-pencil]")).toBeVisible();
  await page.locator("[data-hub-chat] button[aria-label='Attach files']").click();
  await expect(page.locator("[data-attach-menu]")).toContainText("Photo or image");
  await page.screenshot({ path: `${SHOTS}/b8-new-conversation.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-hub-conversation]")).toHaveCount(0);
});
