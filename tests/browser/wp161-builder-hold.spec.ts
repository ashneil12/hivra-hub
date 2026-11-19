import { expect, test } from "@playwright/test";

// WP-161. A builder held by the default disk pause shows up in Needs you with the free space, its action opens
// Settings > Worktrees > Clean up, and the line goes when the disk is back over the floor.
test.use({ viewport: { width: 1100, height: 760 } });

test("a builder held by the disk pause says so in Needs you, opens Clean up, and clears when space is freed", async ({ page }) => {
  await page.goto("/tests/browser/wp161-builder-hold.html");
  await expect(page.getByText("There is no Chief of Staff.")).toBeVisible();
  await expect(page.locator("[data-home-quiet]")).toHaveCount(0);
  await expect(page.getByText("Nothing needs you.")).toHaveCount(0);
  await expect(page.locator("[data-home-line='builders']")).toHaveCount(0);

  // The pause is on with nothing set: a launch at 24 GB free is held.
  await page.locator("#disk-24").click();
  await page.locator("#launch").click();
  await expect(page.locator("body")).toHaveAttribute("data-admission", "health");
  const line = page.locator("[data-home-section='needs-you'] [data-home-line='builders']");
  await expect(line).toBeVisible();
  await expect(line).toContainText("New builders are waiting: 24 GB free, under the 30 GB floor");
  await expect(line.getByRole("button", { name: "Free up space" })).toBeVisible();
  await expect(page.locator("[data-home-quiet]")).toHaveCount(0);
  await expect(page.locator("[data-home-empty]")).toHaveCount(0);
  expect(await line.innerText()).not.toMatch(/[—–]/);

  // Its action opens the Clean up card on Settings > Worktrees.
  await line.getByRole("button", { name: "Free up space" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-opened",
    JSON.stringify({ kind: "settings", section: "worktrees", anchor: "worktree-cleanup" }),
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-settings",
    JSON.stringify({ section: "worktrees", anchor: "worktree-cleanup" }),
  );

  // Still held while the disk is low, however many times it looks again.
  await page.locator("#pump").click();
  await expect(page.locator("body")).toHaveAttribute("data-started", "0");
  await expect(line).toContainText("24 GB free");

  // Space freed: the waiting builder starts and the line is gone.
  await page.locator("#disk-41").click();
  await page.waitForTimeout(4_200);
  await page.locator("#pump").click();
  await expect(page.locator("body")).toHaveAttribute("data-started", "1");
  await expect(page.locator("[data-home-line='builders']")).toHaveCount(0);
  await expect(page.getByText("There is no Chief of Staff.")).toBeVisible();
  await expect(page.locator("[data-home-quiet]")).toHaveCount(0);
  await expect(page.getByText("Nothing needs you.")).toHaveCount(0);
});

test("with the disk pause turned off, a low disk holds nothing and says nothing", async ({ page }) => {
  await page.goto("/tests/browser/wp161-builder-hold.html");
  await page.locator("#disk-off").click();
  await page.locator("#disk-24").click();
  await page.locator("#launch").click();
  await expect(page.locator("body")).toHaveAttribute("data-admission", "start");
  await expect(page.locator("[data-home-line='builders']")).toHaveCount(0);
  await expect(page.getByText("There is no Chief of Staff.")).toBeVisible();
  await expect(page.locator("[data-home-quiet]")).toHaveCount(0);
  await expect(page.getByText("Nothing needs you.")).toHaveCount(0);
});
