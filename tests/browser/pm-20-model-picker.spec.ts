import { expect, test } from "@playwright/test";
import fs from "node:fs";

// E7 proof (a browser fixture, not Ash's Mac): on a Grok-bridge chat the Model menu lists Grok 4.7 and the Other
// models (DeepSeek included); picking one moves the chat to it. One border on the menu.
//   PM_PROOF_SPEC=pm-20-model-picker.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-20";
test.use({ viewport: { width: 900, height: 600 } });

test("a bridge chat's Model menu offers the Other models", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/tests/browser/model-picker-bridge.html");
  const trigger = page.locator('button[aria-haspopup="dialog"]').first();
  await expect(trigger).toContainText("Grok 4.7", { timeout: 60_000 });
  await trigger.click();
  const list = page.locator("[data-bridge-model-list]");
  await expect(list).toBeVisible();
  await expect(list.locator('[role="menuitemradio"]')).toHaveText(["Grok 4.7", /DeepSeek V4/, /Qwen Coder/]);
  const borders = await list.evaluate((el) => {
    const count = (node: Element) => {
      const s = getComputedStyle(node);
      return (parseFloat(s.borderTopWidth) > 0 ? 1 : 0) + (s.boxShadow !== "none" && /inset|0px 0px 0px 1px/.test(s.boxShadow) ? 1 : 0) + (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? 1 : 0);
    };
    return count(el) + (el.parentElement ? count(el.parentElement) : 0);
  });
  expect(borders).toBe(1);
  await page.screenshot({ path: `${SHOTS}/pm-20-model-picker.png` });
  await page.locator('[data-bridge-other-model="ds"]').click();
  await expect(page.locator("[data-fixture-model]")).toHaveAttribute("data-fixture-model", "custom:ds");
});
