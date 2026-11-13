import { expect, test } from "@playwright/test";

test("no test debt line shows when nothing waits to be sorted", async ({ page }) => {
  await page.goto("/tests/browser/test-debt.html?state=none");
  await expect(page.locator("[data-test-debt-line]")).toHaveCount(0);
  await expect(page.locator("[data-test-debt-more]")).toHaveCount(0);
});

test("the line says how many tests wait to be sorted at ship", async ({ page }) => {
  await page.goto("/tests/browser/test-debt.html?state=three");
  await expect(page.getByText("3 tests to sort at ship", { exact: true })).toBeVisible();
  await expect(page.locator("[data-test-debt-count]")).toHaveAttribute("data-test-debt-count", "3");
});

test("one test to sort uses the singular", async ({ page }) => {
  await page.goto("/tests/browser/test-debt.html?state=one");
  await expect(page.getByText("1 test to sort at ship", { exact: true })).toBeVisible();
});

test("More opens a list of each test with its file, since when and its task", async ({ page }) => {
  await page.goto("/tests/browser/test-debt.html?state=three");
  await page.locator("[data-test-debt-more]").click();
  const popover = page.locator("[data-test-debt-popover]");
  await expect(popover).toBeVisible();
  await expect(popover.locator("[data-test-debt-item]")).toHaveCount(3);
  const first = popover.locator("[data-test-debt-item]").first();
  await expect(first.locator("[data-test-debt-test]")).toHaveText("Example: saves the draft (a)");
  await expect(first.locator("[data-test-debt-file]")).toHaveText("src/draft/save.test.ts");
  await expect(first.locator("[data-test-debt-since]")).toHaveText("since 2 days ago");
  await expect(first.locator("[data-test-debt-task]")).toHaveText("from Example: draft saving");
});

test("real bugs and flaky tests are listed with a label and not counted", async ({ page }) => {
  await page.goto("/tests/browser/test-debt.html?state=mixed");
  await expect(page.getByText("2 tests to sort at ship", { exact: true })).toBeVisible();
  await page.locator("[data-test-debt-more]").click();
  const popover = page.locator("[data-test-debt-popover]");
  await expect(popover.locator("[data-test-debt-item]")).toHaveCount(4);
  await expect(popover.locator("[data-test-debt-item='real-bug']")).toContainText("Real bug");
  await expect(popover.locator("[data-test-debt-item='flaky']")).toContainText("Flaky");
});

test("while the app is sorting, the line reads Sorting with the number still to sort", async ({ page }) => {
  await page.goto("/tests/browser/test-debt.html?state=sorting");
  await expect(page.getByText("Sorting 2 tests", { exact: true })).toBeVisible();
});

test("an answer that can't be read shows nothing", async ({ page }) => {
  await page.goto("/tests/browser/test-debt.html?state=garbage");
  await expect(page.locator("[data-test-debt-line]")).toHaveCount(0);
  await expect(page.locator("[data-test-debt-more]")).toHaveCount(0);
});
