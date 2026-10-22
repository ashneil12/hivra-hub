import { expect, test } from "@playwright/test";
import fs from "node:fs";

// Round 24 proof (a browser fixture, not Ash's Mac; tests/browser/r24-mono-chat.tsx, made-up data labelled Example:):
// a Mono's 1:1 fills the window like a room (transcript, composer, tool card, code block); only plain reply text keeps
// the room's 75ch reading limit. Shots at 1512, 1920 and 2560 wide.
//   PM_PROOF_SPEC=pm-24-mono-width.spec.ts PM_PROOF_DIR=/workspace/pm-mac-check/r24 npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-24";
const SIZES = [
  { width: 1512, height: 982 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

for (const size of SIZES) {
  test(`a Mono's 1:1 fills the width at ${size.width}x${size.height}`, async ({ page }) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize(size);
    await page.goto("/tests/browser/r24-mono-chat.html");
    const reply = page.locator('[data-chat-message="a1"]');
    await expect(reply).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-session-composer] form")).toBeVisible();
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => {
      const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
      const W = window.innerWidth;
      const composer = box(document.querySelector("[data-session-composer] form"))!;
      const column = box(document.querySelector(".chat-reading-limit"))!;
      const para = box(document.querySelector('[data-chat-message="a1"] .agent-markdown p'))!;
      const code = box(document.querySelector('[data-chat-message="a1"] [data-streamdown="code-block"]'))!;
      const tool = box(document.querySelector('[data-transcript-content] [data-tool-row], [data-transcript-content] [data-tool-call], [data-transcript-content] button'));
      return {
        W, column: [Math.round(column.left), Math.round(W - column.right)], composer: [Math.round(composer.left), Math.round(W - composer.right)],
        paragraph: Math.round(para.width), code: Math.round(code.width), tool: tool ? Math.round(tool.width) : null,
      };
    });
    console.log(`r24 ${size.width}: ${JSON.stringify(m)}`);
    // The column and the composer reach both sides, with the room's modest padding.
    expect(m.column[0]).toBeLessThanOrEqual(1);
    expect(m.column[1]).toBeLessThanOrEqual(1);
    expect(m.composer[0]).toBeGreaterThanOrEqual(24);
    expect(m.composer[0]).toBeLessThanOrEqual(40);
    expect(m.composer[1]).toBeLessThanOrEqual(40);
    // Plain reply text keeps a reading limit; the code block uses the full width.
    expect(m.paragraph).toBeLessThanOrEqual(760);
    expect(m.code).toBeGreaterThan(size.width - 120);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: `${SHOTS}/r24-mono-1to1-${size.width}.png` });
  });
}
