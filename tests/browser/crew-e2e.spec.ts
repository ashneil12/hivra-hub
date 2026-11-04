import { expect, test } from "@playwright/test";

// WP-42. A person sees the worker's .e2e proof, and not a path that leaves that folder.
test.use({ viewport: { width: 960, height: 400 } });

test("the worker row shows only .e2e proof", async ({ page }) => {
  await page.goto("/tests/browser/crew-e2e.html");
  await expect(page.getByLabel("Verify evidence")).toBeVisible();
  const paths = await page.locator("[data-e2e-path]").allTextContents();
  expect(paths).toEqual([".e2e/report.json", ".e2e/results/home/trace.md", ".e2e/shot.png"]);
  await expect(page.locator("body")).not.toContainText("secret");
  await expect(page.locator("body")).not.toContainText("example.com");
  await expect(page.locator("body")).not.toContainText("passwd");
});
