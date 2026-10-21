import { expect, test } from "@playwright/test";
import fs from "node:fs";

// Round 21 proof (a browser fixture with a faked Tauri bridge, not Ash's Mac): Export's Memory box starts ticked, with
// every memory folder and each Mono's own memory, so "bring my whole setup across" carries every Mono's memory.
//   PM_PROOF_SPEC=pm-21-export.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-21";
test.use({ viewport: { width: 950, height: 820 } });

test("Export opens with Memory ticked", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/tests/browser/export-memory.html");
  const memory = page.locator("[data-portable-choice=memory] [role=checkbox]");
  await expect(memory).toHaveAttribute("aria-checked", "true", { timeout: 60_000 });
  await expect(page.locator("[data-portable-choice=mono-memory] [role=checkbox]")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-portable-choice=memory-example-game] [role=checkbox]")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-portable-choice=workspace] [role=checkbox]")).toHaveAttribute("aria-checked", "false");
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${SHOTS}/pm-21-export-memory-ticked.png` });
});
