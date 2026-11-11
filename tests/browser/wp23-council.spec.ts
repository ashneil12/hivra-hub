import { expect, test } from "@playwright/test";
import fs from "node:fs";

// WP-23 proof (the real room view in a browser, not Ash's Mac; made-up data labelled Example:): a council from the
// team's chat to a verdict. The third seat's first stance is the wrong shape and is asked again.
// Dropwave: council is a mode of the team's chat, turned on by the switch under the box. A sent question is asked like
// any message (no "confirm the question" step), and who sits at the table is behind Set up.
const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/wp23";

test("a council from a team's chat reaches a verdict", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/tests/browser/wp23-council.html");
  await page.locator("[data-hub-council]").click({ timeout: 60_000 });
  await expect(page.getByRole("switch", { name: "Council mode" })).toHaveAttribute("aria-checked", "true");
  // Nothing is asked until a question is sent.
  await expect(page.locator("[data-council-confirm]")).toBeDisabled();
  await page.locator("[data-council-table-toggle]").click();
  await expect(page.locator("[data-council-setup] [data-council-seat]")).toHaveCount(3);
  await page.locator("[data-council-table-toggle]").click();
  await expect(page.locator("[data-council-setup]")).toHaveCount(0);
  await page.locator("[data-council-question]").fill("Example: should we ship the pricing page?");
  await page.screenshot({ path: `${SHOTS}/wp23-proposal.png` });

  await page.locator("[data-council-confirm]").click();
  await expect(page.locator("[data-council-restate]")).toHaveCount(0);

  const delegate = page.locator("[data-council-delegate]");
  await expect(delegate).toContainText("Example: publish the pricing page.", { timeout: 15_000 });
  await expect(page.locator("[data-council-round]")).toHaveAttribute("data-council-round", "done");
  await expect(page.locator("[data-council-outcome]")).toHaveAttribute("data-council-outcome", "consensus");
  await expect(page.locator("[data-council-two-thirds]")).toBeVisible();
  await expect(page.locator("[data-council-minority]")).toContainText("Member C — Wait");
  await expect(page.locator("[data-council-minority]")).not.toContainText("one seat would wait");
  await expect(page.locator("[data-council-tab]")).toHaveCount(3);
  await expect(page.locator("[data-council-seat]")).toHaveCount(3);
  await expect(page.getByText("Asked again")).toBeVisible();
  await expect(page.locator("[data-council-meta]")).toContainText("3 seats · 4 rounds · 11 calls");
  await page.screenshot({ path: `${SHOTS}/wp23-verdict.png` });
});
