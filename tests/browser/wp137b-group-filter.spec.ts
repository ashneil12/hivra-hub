import { expect, test, type Page } from "@playwright/test";

const fullOrder = "pin-old pin-new alpha beta delta gamma";

async function order(page: Page): Promise<string> {
  return page.locator("[data-rail-order]").getAttribute("data-rail-order") ?? "";
}

test("a bad or missing setting leaves the full rail with no filter", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("monocode.showOnlyGroup", "yes");
  });
  await page.goto("/tests/browser/wp137b-group-filter.html");
  await expect(page.locator("[data-group-filter]")).toHaveAttribute("data-group-filter", "off");
  expect(await order(page)).toBe(fullOrder);
  await expect(page.getByRole("button", { name: /Show only this group/ })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});

test("show only this group hides the others and show every project puts them back", async ({ page }) => {
  await page.goto("/tests/browser/wp137b-group-filter.html");
  expect(await order(page)).toBe(fullOrder);

  await page.getByRole("switch", { name: "Show only one group" }).click();
  await page.getByRole("button", { name: "Expand Work" }).click();
  expect(await order(page)).toBe(fullOrder);
  await expect(page.locator("[data-group-filter]")).toHaveAttribute("data-group-filter", "off");

  await page.getByRole("button", { name: "Show only this group, Work" }).click();
  expect(await order(page)).toBe("pin-old alpha beta");
  await expect(page.locator("[data-project=pin-new]")).toHaveCount(0);
  await expect(page.locator("[data-project=gamma]")).toHaveCount(0);
  await expect(page.locator("[data-group-filter]")).toHaveAttribute("data-group-filter", "on");

  await page.getByRole("button", { name: "Show every project" }).click();
  expect(await order(page)).toBe(fullOrder);

  await page.getByRole("button", { name: "Show only this group, Empty" }).click();
  await expect(page.locator("[data-group-empty=empty]")).toHaveText("No projects in this group.");
  await expect(page.locator("[data-project]")).toHaveCount(0);
  await expect(page.locator("[data-group-filter]")).toHaveAttribute("data-group-filter", "on");

  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).not.toContain("monocode.projectRailOrder");
  expect(keys).not.toContain("monocode.projectGroups");
  expect(keys).not.toContain("monocode.projectGroupAssignments");
  expect(keys).not.toContain("monocode.projectRailPinned");
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});

test("a missing group shows the full rail and a plain sentence", async ({ page }) => {
  await page.goto("/tests/browser/wp137b-group-filter.html");
  await page.getByRole("switch", { name: "Show only one group" }).click();
  await page.getByRole("button", { name: "Show only this group, Work" }).click();
  await page.getByRole("button", { name: "Remove Work" }).click();
  await expect(page.getByRole("status")).toHaveText("That group is no longer there.");
  await expect(page.locator("[data-group-filter]")).toHaveAttribute("data-group-filter", "unavailable");
  await expect(page.locator("[data-project=alpha]")).toBeVisible();
  await expect(page.locator("[data-project=gamma]")).toBeVisible();
  expect(await order(page)).toBe("pin-old pin-new delta alpha beta gamma");
  await page.getByRole("button", { name: "Show every project" }).click();
  await expect(page.locator("[data-group-filter]")).toHaveAttribute("data-group-filter", "off");
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("two windows filter apart, and closing one writes nothing", async ({ page, context }) => {
  const other = await context.newPage();
  await page.goto("/tests/browser/wp137b-group-filter.html");
  await other.goto("/tests/browser/wp137b-group-filter.html");
  await page.getByRole("switch", { name: "Show only one group" }).click();
  await expect(other.getByRole("button", { name: "Show only this group, Work" })).toBeVisible();

  await page.getByRole("button", { name: "Show only this group, Work" }).click();
  expect(await order(page)).toBe("pin-old alpha beta");
  expect(await order(other)).toBe(fullOrder);
  await expect(other.locator("[data-group-filter]")).toHaveAttribute("data-group-filter", "off");

  const stored = await other.evaluate(() => JSON.stringify(localStorage));
  await page.close();
  expect(await other.evaluate(() => JSON.stringify(localStorage))).toBe(stored);
  expect(await order(other)).toBe(fullOrder);

  await other.getByRole("button", { name: "Show only this group, Home" }).click();
  expect(await order(other)).toBe("pin-new delta");
  await expect(other.locator("body")).not.toContainText(/[—–]/);
});
