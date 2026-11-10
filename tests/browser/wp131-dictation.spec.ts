import { expect, test, type Page } from "@playwright/test";

// WP-131: desktop dictation in the composer. Dictation writes the words into the draft, marks the words still being
// heard, and never sends. The engine is a fake: `window.__dictation` counts the starts and stops, and
// `window.__emitDictation` plays the recogniser's chunks.

const DENIED = "Dictation needs the microphone and speech recognition. Turn them on in System Settings, then try again.";
const EXPLAIN_TEXT = "Nothing is sent until you press Send.";

type Calls = { starts: number; stops: number[]; submitted: string[]; startError: string | null };

const dictate = (page: Page) => page.locator('button[aria-label="Dictate"]');
const draft = (page: Page) => page.getByLabel("Message the lead");
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __dictation: Calls }).__dictation);
const emit = (page: Page, payload: Record<string, unknown>) =>
  page.evaluate((value) => (window as unknown as { __emitDictation: (p: unknown) => void }).__emitDictation(value), payload);

test("dictation writes into the draft, marks the words still being heard, and never sends", async ({ page }) => {
  await page.goto("/tests/browser/wp131-dictation.html");
  await expect(dictate(page)).toBeVisible({ timeout: 15_000 });

  // Asking shows the plain-words explanation first. Nothing starts until Continue.
  await dictate(page).click();
  await expect(page.locator("[data-dictation-explain]")).toContainText(EXPLAIN_TEXT);
  expect((await calls(page)).starts).toBe(0);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("[data-dictation-status]")).toHaveText("Still listening");
  expect((await calls(page)).starts).toBe(1);

  // A partial result lands in the draft and is marked until the person stops.
  await emit(page, { session: 1, text: "buy milk", finished: false, error: false });
  await expect(draft(page)).toHaveValue("buy milk");
  await expect(page.locator("[data-dictation-partial]")).toHaveText("buy milk");
  expect((await calls(page)).submitted).toEqual([]);

  // Stopping drops the mark, keeps the words, and still sends nothing.
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect.poll(async () => (await calls(page)).stops).toEqual([1]);
  await emit(page, { session: 1, text: "Buy milk.", finished: true, error: false });
  await expect(draft(page)).toHaveValue("Buy milk.");
  await expect(page.locator("[data-dictation-partial]")).toHaveCount(0);
  await expect(dictate(page)).toBeVisible();
  expect((await calls(page)).submitted).toEqual([]);

  // Only the person's own send submits the draft.
  await draft(page).click();
  await draft(page).press("Enter");
  await expect.poll(async () => (await calls(page)).submitted).toEqual(["Buy milk."]);
});

test("Not now starts nothing, and a refused permission shows a plain note", async ({ page }) => {
  await page.goto("/tests/browser/wp131-dictation.html");
  await expect(dictate(page)).toBeVisible({ timeout: 15_000 });

  await dictate(page).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("[data-dictation-explain]")).toHaveCount(0);
  expect((await calls(page)).starts).toBe(0);

  await page.evaluate((note) => {
    (window as unknown as { __dictation: Calls }).__dictation.startError = note;
  }, DENIED);
  await dictate(page).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("[data-dictation-note]")).toHaveText(DENIED);
  await expect(dictate(page)).toBeVisible();
  expect((await calls(page)).starts).toBe(0);
  expect((await calls(page)).submitted).toEqual([]);
});

test("typing in the draft ends dictation and keeps what the person typed", async ({ page }) => {
  await page.goto("/tests/browser/wp131-dictation.html");
  await expect(dictate(page)).toBeVisible({ timeout: 15_000 });
  await dictate(page).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("[data-dictation-status]")).toHaveText("Still listening");

  await emit(page, { session: 1, text: "buy", finished: false, error: false });
  await draft(page).fill("my own words");
  await expect(page.locator("[data-dictation-status]")).toHaveCount(0);
  await emit(page, { session: 1, text: "buy milk", finished: true, error: false });
  await expect(draft(page)).toHaveValue("my own words");
  await expect.poll(async () => (await calls(page)).stops).toEqual([1]);
});

test("the control is not offered where the desktop recogniser is not available", async ({ page }) => {
  await page.goto("/tests/browser/wp131-dictation.html?unsupported");
  await expect(draft(page)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await expect(dictate(page)).toHaveCount(0);
});
