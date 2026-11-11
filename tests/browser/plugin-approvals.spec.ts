import { expect, test } from "@playwright/test";

// WP-101: what the install check found, on the card the person already sees.
test("the install card shows what the check found, and a clean plugin says so", async ({ page }) => {
  await page.goto("/tests/browser/plugin-approvals.html");
  const card = page.locator("[data-request='11111111-1111-4111-8111-111111111111']");
  const clean = page.locator("[data-request='22222222-2222-4222-8222-222222222222']");
  await expect(card).toContainText("Install word-counter 1.0.0");

  const check = card.getByRole("region", { name: "Install check" });
  await expect(check).toContainText("The install check found 1 thing to know about. None of them stops the install.");
  await expect(check).toContainText("skills/count/scripts/run.py: A script is copied with the plugin; Hivra never runs it.");
  // The info rows are not shown as warnings.
  await expect(check).not.toContainText("It holds 4 files.");

  await expect(clean.getByRole("region", { name: "Install check" })).toContainText("The install check found nothing to flag.");
  await expect(clean.getByRole("region", { name: "Install check" }).locator("li")).toHaveCount(0);

  await card.getByRole("button", { name: "Don't install" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute(
    "data-last-answer",
    JSON.stringify({ command: "plugins_decline", id: "11111111-1111-4111-8111-111111111111" }),
  );
});
