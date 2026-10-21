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
  await expect(page.locator("[data-hub-new-conversation-screen]")).toContainText("Click the pencil to name it.");
  await expect(page.locator("[data-hub-conversation-draft-word]")).toHaveText("Draft");
  await page.screenshot({ path: `${SHOTS}/b8-new-conversation.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-hub-conversation]")).toHaveCount(0);
});

test("G4: each Mono's role is a small second line under its name on the rail, at any width, and in the header and tooltip; a Lead has none", async ({ page }) => {
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
  // At the default width every role shows on its own line under the name; the name keeps the first row.
  for (const [name, role] of [["Chief of Staff", "Business partner across every project"], ["frank", "Memory and checks"], ["Alfred", "Team setup"]]) {
    const row = rail.locator(`button[aria-label^="${name}"]`).first();
    await expect(row.locator("[data-mono-role]")).toBeVisible();
    await expect(row.locator("[data-mono-role]")).toHaveText(role);
    const [n, r] = [await row.locator("[data-mono-primary-name]").boundingBox(), await row.locator("[data-mono-role]").boundingBox()];
    expect(r!.y).toBeGreaterThanOrEqual(n!.y + n!.height - 2);
  }
  const heights = await rail.locator("button[aria-label][title]").evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.closest(".reorder-item")?.getBoundingClientRect().height ?? 0)).filter(Boolean))]);
  expect(heights).toEqual([32]); // every row the same height, with or without a role
  await page.mouse.move(700, 450);
  await shot(page, "g4-role-labels");
  // The narrow rail: the role is still there, the name still has its whole first row.
  await page.evaluate(() => {
    const list = document.querySelector("[data-mono-rail]") as HTMLElement;
    let el: HTMLElement | null = list;
    while (el && el.getBoundingClientRect().left > 80) el = el.parentElement;
    (list.closest("aside") ?? list).style.width = "160px";
    list.style.width = "160px";
  });
  await expect(cos.locator("[data-mono-role]")).toBeVisible();
  await expect(rail.locator('button[aria-label^="Alfred"] [data-mono-role]')).toBeVisible();
  await expect(cos).toHaveAttribute("title", /\nBusiness partner across every project/);
  const pm = rail.locator('button[aria-label^="frank"] [data-mono-primary-name]').first();
  const box = await pm.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.scroll).toBeLessThanOrEqual(box.client); // the name is not cut
  const railBox = await rail.boundingBox();
  await page.screenshot({ path: `${SHOTS}/g4-narrow-rail.png`, clip: { x: 0, y: 0, width: Math.ceil((railBox?.x ?? 0) + 200), height: 420 } });
});

test("G4 tiles: every Mono's tile is its little image by default; letters are a choice in the picker, shown as typed", async ({ page }) => {
  await open(page);
  const rail = page.locator("[data-mono-rail]").first();
  const alfred = rail.locator('button[aria-label^="Alfred"]').first();
  // Images by default on every rail tile: no tile is letters until Ash picks them.
  expect(await rail.locator("button[aria-label][title] svg.pixel-mascot").count()).toBeGreaterThan(3);
  expect(await rail.locator("button[aria-label][title] svg text").count()).toBe(0);
  await alfred.click();
  await page.getByRole("button", { name: "Alfred settings" }).click();
  await page.getByRole("button", { name: "Change mascot and color" }).click();
  const look = page.getByRole("dialog", { name: "Mascot and color" });
  await expect(look).toBeVisible();
  expect(await look.locator("button svg").count()).toBeGreaterThan(5);
  await look.locator("[data-mono-tile-letters]").fill("Af");
  await look.locator("[data-mono-tile-letters]").press("Enter");
  await expect(alfred.locator("svg text").first()).toHaveText("Af");
  await shot(page, "g4-tile-letters");
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
  await expect(page.getByText("Sample page. No Mono has built this yet.")).toBeVisible();
  await expect(page.getByText(/No real Mono ran/)).toHaveCount(0);
  await calendar.scrollIntoViewIfNeeded();
  await page.mouse.move(5, 450);
  await shot(page, "c6-calendar-block");
});

test("PM-20: made-up data says Example: on Today (the stub's jobs and asks); Stuck is one red", async ({ page }) => {
  await open(page);
  const built = page.locator("[data-hub-today-being-built]").first();
  await expect(built).toContainText("Example: adding the air dodge", { timeout: 30_000 });
  await expect(built).not.toContainText(/(^|[^:] )Adding the air dodge/);
  // Stuck is one red everywhere on Today: no amber ring next to a Stuck word.
  await expect(page.getByText("Stuck").first()).toBeVisible();
  const stuckStrokes = await page.evaluate(() =>
    [...document.querySelectorAll("svg circle")]
      .filter((c) => /^\s*Stuck\s*$/.test(c.closest("svg")?.parentElement?.textContent ?? ""))
      .map((c) => c.getAttribute("stroke")),
  );
  expect(stuckStrokes.length).toBeGreaterThan(0);
  expect(new Set(stuckStrokes)).toEqual(new Set(["rgb(239 68 68)"]));
  await expect(page.getByText(/Tried before it reached the lead/)).toHaveCount(0);
  await page.mouse.move(5, 450);
  await shot(page, "pm20-today-example-labels");
});
