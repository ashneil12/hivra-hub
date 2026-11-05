import { expect, test } from "@playwright/test";

// WP-84. A phased task shows its documents in order, and the decision at each review.
test.use({ viewport: { width: 960, height: 720 } });

test("a phased task shows its documents and the decision", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/phases.html");
  await page.getByRole("button", { name: "#4 Fix the save" }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: "Research, plan, build" })).toBeVisible();
  await expect(page.getByText("Research found the save drops the last line.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Looks right" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change this" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip to building" })).toBeVisible();
  await expect(page.getByText("Keep the last line in the file.")).toHaveCount(0);

  await page.getByRole("button", { name: "Looks right" }).click();
  await expect(page.getByText("Keep the last line in the file.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Looks right" })).toBeVisible();
  const text = await page.getByRole("article").innerText();
  expect(text.indexOf("Research found the save drops the last line.")).toBeLessThan(text.indexOf("Keep the last line in the file."));
  await page.screenshot({ path: testInfo.outputPath("phases.png") });
});
