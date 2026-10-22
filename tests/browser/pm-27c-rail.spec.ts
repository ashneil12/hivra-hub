import { expect, test } from "@playwright/test";
import fs from "node:fs";

// Round 27c proof (the real Monos rail in a browser via the r27b-rail fixture; not Ash's Mac; made-up data labelled
// Example:). Critiquito on the r27b rail shot: no spinning or working mark on a Needs you; the OK problems in plain
// words (no file names, no "seat", no doubled colon); the "Waiting for your OK" cards with a solid outline.
//   PM_PROOF_SPEC=pm-27c-rail.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-27c";

test("r27c: the rail's Needs you has no spinner, its problems are plain, its waiting cards solid", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.goto("/tests/browser/r27b-rail.html");
  const red = page.locator('[data-mono-failed="ex-hivra-lead"]');
  await expect(red.locator("[data-hub-chip]")).toHaveText("Needs you", { timeout: 60_000 });
  await expect(red.locator("[data-mono-failed-retry], [class*='animate-']")).toHaveCount(0);
  for (const name of ["Example: Ledger", "Example: Scout"]) {
    const box = page.locator("[data-soul-waiting-card]", { hasText: name }).first();
    await box.getByRole("button", { name: "OK", exact: true }).click();
  }
  await expect(page.locator('[data-mono-soul-problem="needs-you"]')).toHaveText("Needs youCouldn't add Example: Scout because the disk is full", { timeout: 10_000 });
  await expect(page.locator('[data-mono-soul-problem="grey"]')).toHaveText("Couldn't read Example: Ledger's setup, so it was left as it was");
  const rail = (await page.locator("[data-proof-rail]").textContent())!;
  expect(rail).not.toMatch(/\bseat|SOUL\.md|\.md\b|permission denied|::/i);
  for (const card of await page.locator("[data-soul-waiting-card]").all())
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/pm-27c-rail-1512.png`, clip: { x: 0, y: 0, width: 520, height: 700 } });
});
