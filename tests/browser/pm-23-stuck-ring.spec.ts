import { expect, test } from "@playwright/test";
import fs from "node:fs";

// Round 23 proof (a browser fixture, not Ash's Mac; tests/browser/agent-notes.tsx, made-up data labelled Example:):
// the stuck note keeps Today's red ring with no 'Stuck' word beside it (the line says stuck once); the ring is named
// 'Stuck' for screen readers and sits on the text's baseline. Writes only pm-23-stuck-ring.png.
//   PM_PROOF_SPEC=pm-23-stuck-ring.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-23";
test.use({ viewport: { width: 1100, height: 760 } });

test("the stuck note's ring: no word, named Stuck, on the baseline", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/tests/browser/agent-notes.html");
  const stuck = page.locator('[data-agent-note="stuck"]');
  await expect(stuck).toBeVisible({ timeout: 60_000 });
  await expect(stuck).toHaveText('Worker "Example: fix the save bug" got stuck: Example: the test save file is missing');
  expect((await stuck.textContent())!.match(/stuck/gi)).toHaveLength(1);
  const ring = page.getByRole("img", { name: "Stuck" });
  await expect(ring).toHaveCount(1);
  await expect(ring.locator("circle")).toHaveAttribute("stroke", "rgb(239 68 68)");
  await expect(page.locator('[data-agent-note]:not([data-agent-note="stuck"]) [data-hub-circle]')).toHaveCount(0);
  // Baseline: the ring's bottom edge sits on the words' baseline (measured with a zero-height marker in the text).
  const gap = await stuck.evaluate((row) => {
    const words = row.querySelector("[data-agent-note-ring] + span")!;
    const marker = document.createElement("span");
    marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    words.prepend(marker);
    const baseline = marker.getBoundingClientRect().top;
    marker.remove();
    return row.querySelector("[data-agent-note-ring] svg")!.getBoundingClientRect().bottom - baseline;
  });
  expect(Math.abs(gap)).toBeLessThanOrEqual(1);
  await page.locator("[data-agent-note-fold]").nth(0).click();
  await page.locator("[data-agent-note-fold]").nth(1).click();
  await page.mouse.move(5, 5);
  const shot = `${SHOTS}/pm-23-stuck-ring.png`;
  expect(SHOTS === "proofs" && fs.existsSync(shot)).toBe(false); // never overwrite an older proof
  await page.screenshot({ path: shot });
});
