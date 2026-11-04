import { expect, test } from "@playwright/test";
import fs from "node:fs";

// Round 21 proofs (a browser fixture, not Ash's Mac; tests/browser/agent-notes.tsx, made-up data labelled Example:):
// a folded line is just the count; a stuck note stays on its own line while routine notes either side fold; a single
// note doesn't repeat its task when the detail is the worker's label.
//   PM_PROOF_SPEC=pm-21-agent-notes.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-21";
test.use({ viewport: { width: 1100, height: 760 } });

test("round 21: count-only folds, stuck never folds, no repeated task", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/tests/browser/agent-notes.html");
  const single = page.locator("[data-agent-note]").first();
  await expect(single).toBeVisible({ timeout: 60_000 });
  // r91: a brief reads "handed a job to" (agentNotes.ts noteVerb).
  await expect(single).toHaveText('EXO lead handed a job to Worker "Example: fix the save bug"');
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${SHOTS}/pm-21-note-single.png` });

  const folds = page.locator("[data-agent-note-fold]");
  // r78 (ddac604): each finished worker is its own short "X is back" line, so only the three briefs fold.
  await expect(folds).toHaveText(["3 team notes"]);
  await expect(page.locator('[data-agent-note="reported"]')).toHaveText([
    "Example: tidy the HUD is back: Example: the HUD is tidied, the score moved top right",
    "Example: fix the jump sound is back: Example: the jump sound plays once now",
  ]);
  await expect(page.locator("[data-agent-note-group] [data-agent-note]")).toHaveCount(0);
  // The stuck note sits between the two folds on its own line, never inside one.
  const stuck = page.locator('[data-agent-note="stuck"]');
  await expect(stuck).toHaveCount(1);
  // r30b: a stopped worker's note never says "got stuck"; it is with its Lead (agentNotes.ts stoppedWords).
  await expect(stuck).toHaveText('Worker "Example: fix the save bug" is with EXO lead: Example: the test save file is missing');
  expect(await stuck.evaluate((el) => !!el.closest("[data-agent-note-group]"))).toBe(false);
  await page.screenshot({ path: `${SHOTS}/pm-21-notes-folded.png` });

  await folds.nth(0).click();
  await expect(page.locator("[data-agent-note-group] [data-agent-note]")).toHaveCount(3);
  await expect(page.locator('[data-agent-note-group] [data-agent-note="stuck"]')).toHaveCount(0);
  await expect(stuck).toBeVisible();
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${SHOTS}/pm-21-stuck-unfolded.png` });
});
