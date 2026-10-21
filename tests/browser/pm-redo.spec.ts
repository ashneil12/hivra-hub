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

test("G4: each Mono's role shows after its name on the rail, in the header and tooltip; a Lead has none; narrow rail cuts the role", async ({ page }) => {
  await open(page);
  const rail = page.locator("[data-mono-rail]").first();
  const cos = rail.locator('button[aria-label^="Chief of Staff"]').first();
  await expect(cos).toHaveAttribute("title", /^Chief of Staff\nBusiness partner/);
  await expect(rail.locator('button[aria-label^="EXO lead"] [data-mono-role]')).toHaveCount(0);
  await cos.click();
  await expect(page.locator("[data-mono-title] [data-mono-role-edit]")).toHaveText("Business partner");
  await page.locator("[data-mono-title] [data-mono-role-edit]").click();
  await page.locator("[data-mono-role-input]").fill("Business partner across every project");
  await page.locator("[data-mono-role-input]").press("Enter");
  await expect(page.locator("[data-mono-title] [data-mono-role-edit]")).toHaveText("Business partner across every project");
  await expect(cos).toHaveAttribute("title", /^Chief of Staff\nBusiness partner across every project/);
  await page.mouse.move(700, 450);
  await shot(page, "g4-role-labels");
  // The narrow rail: the role is cut, the name is not.
  await page.evaluate(() => {
    const list = document.querySelector("[data-mono-rail]") as HTMLElement;
    let el: HTMLElement | null = list;
    while (el && el.getBoundingClientRect().left > 80) el = el.parentElement;
    (list.closest("aside") ?? list).style.width = "170px";
    list.style.width = "170px";
  });
  // Under about 200px the role is hidden and every name has the whole row; the role stays in the tooltip.
  await expect(cos.locator("[data-mono-role]")).toBeHidden();
  await expect(cos).toHaveAttribute("title", /\nBusiness partner across every project/);
  const pm = rail.locator('button[aria-label^="Projects Manager"] [data-mono-primary-name]').first();
  const box = await pm.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.scroll).toBeLessThanOrEqual(box.client);
  const railBox = await rail.boundingBox();
  await page.screenshot({ path: `${SHOTS}/g4-narrow-rail.png`, clip: { x: 0, y: 0, width: Math.ceil((railBox?.x ?? 0) + 200), height: 420 } });
});

test("C6: a Page's calendar block is react-day-picker on the theme's tokens", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^Pages/ }).first().click();
  const newButton = page.locator("[data-pages-new-button]").first();
  if (await newButton.isVisible().catch(() => false)) await newButton.click();
  await page.getByLabel("Describe the page").fill("plan my week, with a calendar");
  await page.getByLabel("Send to a Mono").click();
  const calendar = page.locator("[data-block-calendar]").first();
  await expect(calendar).toBeVisible({ timeout: 30_000 });
  await expect(calendar.locator("th")).toHaveText(["M", "T", "W", "T", "F", "S", "S"]);
  await calendar.scrollIntoViewIfNeeded();
  await page.mouse.move(5, 450);
  await shot(page, "c6-calendar-block");
});

test("PM-20: made-up data says Example: on Today (the stub's jobs and asks)", async ({ page }) => {
  await open(page);
  const built = page.locator("[data-hub-today-being-built]").first();
  await expect(built).toContainText("Example: adding the air dodge", { timeout: 30_000 });
  await expect(built).not.toContainText(/(^|[^:] )Adding the air dodge/);
  await page.mouse.move(5, 450);
  await shot(page, "pm20-today-example-labels");
});
