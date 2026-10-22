import { expect, test } from "@playwright/test";
import fs from "node:fs";

// Round 29 proof (the real room view in a browser, not Ash's Mac; made-up data labelled Example:): Chief of Staff's
// draft of a new Mono is a message in the conversation, after the replies, in the scroll; nothing floats over the chat.
// Its skills read "Copywriting, Human writing", never ids.
//   PM_PROOF_SPEC=pm-29-draft.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-29";

test("the drafted Mono's card sits in the chat, after the messages, with plain skill names", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto("/tests/browser/r29-draft.html");
  const card = page.locator("[data-mono-draft]");
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  await expect(card.locator("[data-mono-draft-skills]")).toHaveText("Copywriting, Human writing");
  await expect(card).not.toContainText("ash-copywriting");
  // In the flow: no fixed, absolute or sticky box from the card up to the conversation's scroll (the app's own root is
  // fixed to the window, as every screen's is).
  const positions = await card.evaluate((el) => {
    const out: string[] = [];
    const scroll = el.closest(".overflow-y-auto");
    if (!scroll) return ["outside the scroll"];
    for (let e: Element | null = el; e && e !== scroll.parentElement; e = e.parentElement) out.push(getComputedStyle(e).position);
    return out;
  });
  console.log(`pm-29 positions: ${positions.join(" > ")}`);
  expect(positions.filter((p) => p === "fixed" || p === "absolute" || p === "sticky")).toEqual([]);
  // It covers no message: every message's box ends above the card's top.
  const overlap = await page.evaluate(() => {
    const c = document.querySelector("[data-mono-draft]")!.getBoundingClientRect();
    const scroll = document.querySelector("[data-mono-draft]")!.closest(".overflow-y-auto")!;
    const msgs = [...scroll.querySelectorAll("[data-hub-msg-ref], [data-hub-msg-ash], p, div > span")].filter((m) => !m.closest("[data-mono-draft]") && m.textContent?.startsWith("Example:"));
    return msgs.filter((m) => {
      const r = m.getBoundingClientRect();
      return r.bottom > c.top + 1 && r.top < c.bottom - 1;
    }).map((m) => m.textContent?.slice(0, 40));
  });
  expect(overlap).toEqual([]);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/pm-29-draft-in-chat-1512.png` });
});
