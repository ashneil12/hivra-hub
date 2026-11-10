import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp144-fresh-eyes.html";

test("the review starts off, then shows findings and clears when you approve", async ({ page }) => {
  await page.goto(pageUrl);
  const toggle = page.getByRole("switch", { name: "Fresh-eyes review before crew starts" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-fresh-eyes-line]")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const line = page.locator("[data-fresh-eyes-line]");
  await expect(line).toHaveText("Fresh-eyes review: 2 findings, waiting on you");
  // The card says which brief Approve would start.
  await expect(page.locator("[data-fresh-eyes-brief]")).toHaveText("Save the note. Done when a reload keeps it.");
  await expect(page.getByText("Done is not defined.")).toBeVisible();
  await expect(page.getByText("The reload step is missing.")).toBeVisible();

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(line).toHaveText("Fresh-eyes review: cleared");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Another plan" }).click();
  await expect(line).toHaveText("Fresh-eyes review: 2 findings, waiting on you");
  await page.getByRole("button", { name: "Skip once", exact: true }).click();
  await expect(line).toHaveText("Fresh-eyes review: skipped once");

  const card = await page.getByRole("region", { name: "Fresh-eyes review" }).innerText();
  expect(card).not.toMatch(/[—–]/);
});

test("a late reply for the previous project does not overwrite the current one", async ({ page }) => {
  await page.goto(pageUrl);
  await page.getByRole("button", { name: "Slow project" }).click();
  await page.getByRole("switch", { name: "Fresh-eyes review before crew starts" }).click();
  await page.getByRole("button", { name: "Other project" }).click();
  await expect(page.getByRole("switch", { name: "Fresh-eyes review before crew starts" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.evaluate(() => (window as unknown as { releaseStale: () => void }).releaseStale());
  await expect(page.getByRole("switch", { name: "Fresh-eyes review before crew starts" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.locator("[data-fresh-eyes-line]")).toHaveCount(0);
});
