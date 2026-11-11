// WP-243: what an approval card shows. The exact command an Allow runs, whole; "Allowed because you said …" on a card
// Ash's own words covered; and a call a restart cut while it may have been running.
import { expect, test } from "@playwright/test";

const LONG =
  "npm run build --workspace example-app && node scripts/example-check.mjs --strict --report target/example-report.json --since 2026-11-01";

test("an open card shows the exact command it would run, whole", async ({ page }) => {
  await page.goto("/tests/browser/wp243-approval.html");
  const exact = page.locator("[data-approval-exact]");
  await expect(exact).toHaveCount(1);
  await expect(exact).toHaveText(LONG);
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
});

test("a card Ash's own words covered says which words", async ({ page }) => {
  await page.goto("/tests/browser/wp243-approval.html");
  await expect(page.locator("[data-approval-covered]")).toHaveText(
    "Allowed because you said “install lodash and run the tests”.",
  );
});

test("a call a restart cut says it may have run and won't run again by itself", async ({ page }) => {
  await page.goto("/tests/browser/wp243-approval.html");
  await expect(page.locator("[data-tool-uncertain]")).toHaveText(
    "A restart cut this while it may have been running. It won't run again by itself.",
  );
});
