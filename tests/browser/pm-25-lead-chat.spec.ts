import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

// Round 25 proof (a browser fixture, not Ash's Mac; tests/browser/r25-lead-chat.tsx, made-up data labelled Example:):
//   1. "Jump to latest" never covers text: it sits in the band the transcript keeps clear, and pinned to the end the
//      last line rests above that band.
//   2. A worker's card takes the replies' reading width (up to 640px), not a narrow pill.
//   5. With the 1:1 open no sidebar project item is highlighted; with none open, the open team is the only one
//      (Dropwave dropped the Coding team row, so the proof uses the Leadership team).
// Shots at 1512 and 2560 wide.
//   PM_PROOF_SPEC=pm-25-lead-chat.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-25";
const SIZES = [
  { width: 1512, height: 982 },
  { width: 2560, height: 1440 },
];

async function open(page: Page, size: { width: number; height: number }, query = "") {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize(size);
  await page.goto(`/tests/browser/r25-lead-chat.html${query}`);
  await expect(page.locator('[data-chat-message="a2"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-launched-session]").first()).toBeVisible();
  await page.waitForTimeout(800);
}
const highlighted = (page: Page) =>
  page.$$eval("[data-hub-item]", (els) => els.filter((e) => e.className.split(/\s+/).includes("bg-selection")).map((e) => e.textContent));

for (const size of SIZES) {
  test(`r25 ${size.width}: Jump to latest clears the text, worker cards at reading width, one highlight`, async ({ page }) => {
    await open(page, size);
    const scroller = page.locator(".agent-transcript.mono-transcript-fades");

    // 1a. Pinned to the end: the last line sits where the transcript is fully opaque (56px or more up from its bottom).
    const pinned = await scroller.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const paras = el.querySelectorAll('[data-chat-message="a2"] .agent-markdown p');
      const last = paras[paras.length - 1].getBoundingClientRect();
      return { gap: Math.round(box.bottom - last.bottom), mask: getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage };
    });
    console.log(`r25 ${size.width} pinned: ${JSON.stringify(pinned)}`);
    expect(pinned.gap).toBeGreaterThanOrEqual(56);
    expect(pinned.mask).toContain("rgba(0, 0, 0, 0) calc(100% - 40px)"); // the band under the button: fully clear

    // 1b. Scrolled up a little (the bad case on the Mac): the button shows, wholly inside the band kept clear.
    await scroller.hover();
    await page.mouse.wheel(0, -40);
    const jump = page.locator("[data-jump-to-bottom]");
    await expect(jump).toBeVisible();
    const clear = await page.evaluate(() => {
      const el = document.querySelector(".agent-transcript.mono-transcript-fades")!;
      const box = el.getBoundingClientRect();
      const b = document.querySelector("[data-jump-to-bottom]")!.getBoundingClientRect();
      // Text whose box meets the button's, and how far its visible part (outside the clear band) reaches down.
      const band = box.bottom - 40;
      const hits: string[] = [];
      for (const p of el.querySelectorAll(".agent-markdown p, [data-launched-session]")) {
        for (const r of p.getClientRects()) {
          const meets = r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom;
          if (meets && r.top < band && Math.min(r.bottom, b.bottom) > band) hits.push((p.textContent ?? "").slice(0, 40));
        }
      }
      return { buttonTop: Math.round(box.bottom - b.top), buttonBottom: Math.round(box.bottom - b.bottom), visibleTextUnderButton: hits };
    });
    console.log(`r25 ${size.width} jump: ${JSON.stringify(clear)}`);
    expect(clear.buttonTop).toBeLessThanOrEqual(40 - 8);
    expect(clear.buttonBottom).toBeGreaterThanOrEqual(0);
    expect(clear.visibleTextUnderButton).toEqual([]);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/pm-25-1-jump-to-latest-${size.width}.png` });
    const sb = await scroller.boundingBox();
    await page.screenshot({ path: `${SHOTS}/pm-25-1-jump-to-latest-${size.width}-zoom.png`, clip: { x: sb!.x, y: sb!.y + sb!.height - 220, width: sb!.width, height: 220 } });

    // 2. Worker cards: the replies' reading width, not a pill.
    await scroller.evaluate((el) => (el.querySelector("[data-launched-session]") as HTMLElement).scrollIntoView({ block: "center" }));
    await page.waitForTimeout(400);
    const cards = await page.$$eval("[data-launched-session]", (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    const replyText = await page.$eval('[data-chat-message="a2"] .agent-markdown p', (e) => Math.round(e.getBoundingClientRect().width));
    console.log(`r25 ${size.width} cards: ${JSON.stringify({ cards, replyText })}`);
    expect(cards).toHaveLength(2);
    for (const w of cards) {
      expect(w).toBeGreaterThanOrEqual(600);
      expect(w).toBeLessThanOrEqual(640);
    }
    await page.mouse.move(5, 5);
    await page.screenshot({ path: `${SHOTS}/pm-25-2-worker-cards-${size.width}.png` });

    // 5. With the 1:1 open, no project item is highlighted.
    expect(await highlighted(page)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/pm-25-5-sidebar-1to1-open-${size.width}.png` });
  });

  test(`r25 ${size.width}: with no 1:1 open, the open team is the one highlight`, async ({ page }) => {
    await open(page, size, "?mono=0");
    expect(await highlighted(page)).toEqual(["Leadership team"]);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: `${SHOTS}/pm-25-5-sidebar-no-1to1-${size.width}.png` });
  });
}
