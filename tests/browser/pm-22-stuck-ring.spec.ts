import { expect, test } from "@playwright/test";
import fs from "node:fs";

// Round 22 proof (a browser fixture, not Ash's Mac; tests/browser/agent-notes.tsx, made-up data labelled Example:):
// a 'got stuck' note carries Today's own small red Stuck ring (StatusMark); routine notes have none; the words stay muted.
// Writes only pm-22-stuck-ring.png.
//   PM_PROOF_SPEC=pm-22-stuck-ring.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-22";
test.use({ viewport: { width: 1100, height: 760 } });

test("a stuck note has Today's red Stuck ring; routine notes don't", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/tests/browser/agent-notes.html");
  const stuck = page.locator('[data-agent-note="stuck"]');
  await expect(stuck).toBeVisible({ timeout: 60_000 });
  const ring = stuck.locator("[data-agent-note-ring] [data-hub-circle=red]");
  await expect(ring).toHaveAttribute("aria-label", "Stuck"); // round 23: ring only, the word is its accessible name
  await expect(ring.locator("circle")).toHaveAttribute("stroke", "rgb(239 68 68)");
  // The rest of the row stays muted grey.
  const color = await stuck.evaluate((el) => getComputedStyle(el.querySelector("[data-agent-note-ring] + span")!).color);
  expect(color).not.toMatch(/239, 68, 68/);
  await page.locator("[data-agent-note-fold]").nth(0).click();
  await page.locator("[data-agent-note-fold]").nth(1).click();
  await expect(page.locator("[data-agent-note] [data-hub-circle]")).toHaveCount(1);
  await expect(page.locator('[data-agent-note]:not([data-agent-note="stuck"]) [data-hub-circle]')).toHaveCount(0);
  await page.mouse.move(5, 5);
  const shot = `${SHOTS}/pm-22-stuck-ring.png`;
  expect(fs.existsSync(shot) && SHOTS === "proofs").toBe(false); // never overwrite an older proof
  await page.screenshot({ path: shot });
});
