import { expect, test } from "@playwright/test";

test("a backup shows its schedule and one chat can be restored", async ({ page }) => {
  await page.goto("/tests/browser/backups.html");
  await expect(page.locator("[data-backup-schedule]")).toHaveText("Daily");
  await expect(page.getByText("Last good backup 4 Nov 2026")).toBeVisible();
  await expect(page.getByText("Ship plan", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("Restored as Ship plan (restored)")).toBeVisible();
  await page.getByRole("button", { name: "Restore everything" }).click();
  await expect(
    page.getByText("This quits Hivra, puts this backup back, and keeps a copy of what is here now."),
  ).toBeVisible();
});

test("an empty backup list says there is no backup yet", async ({ page }) => {
  await page.goto("/tests/browser/backups.html?empty");
  await expect(page.getByText("No backup yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore everything" })).toHaveCount(0);
});
