import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp132b-review-guide.html";

test("the guide stays hidden until the setting is on", async ({ page }) => {
  await page.goto(pageUrl);
  const toggle = page.getByRole("switch", { name: "Review guide" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Inbox unchanged")).toBeVisible();
  await expect(page.getByRole("region", { name: "Guide" })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("region", { name: "Guide" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Write guide" })).toBeVisible();

  await page.getByRole("button", { name: "Show GitLab" }).click();
  await expect(page.getByText("Inbox unchanged")).toBeVisible();
  await expect(page.getByRole("region", { name: "Guide" })).toHaveCount(0);
});

test("a stop jumps to the file and a new head is not shown as current", async ({
  page,
}) => {
  await page.goto(pageUrl);
  await page.getByRole("switch", { name: "Review guide" }).click();
  await page.getByRole("button", { name: "Write guide" }).click();
  await expect(page.getByText("The return value changed.")).toBeVisible();
  await expect(page.getByText("Look closely")).toBeVisible();

  await page.getByRole("button", { name: /src\/app.ts/ }).click();
  await expect(page.getByText("Jumped to src/app.ts")).toBeVisible();

  await page.getByRole("button", { name: "New head" }).click();
  await expect(page.getByText("This guide is out of date.")).toBeVisible();
  await expect(page.getByText("The return value changed.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rewrite guide" })).toBeVisible();
});

test("a failed rewrite keeps the guide that was already there", async ({ page }) => {
  await page.goto(pageUrl);
  await page.getByRole("switch", { name: "Review guide" }).click();
  await page.getByRole("button", { name: "Write guide" }).click();
  await expect(page.getByText("The return value changed.")).toBeVisible();

  await page.getByRole("button", { name: "Fail next" }).click();
  await page.getByRole("button", { name: "Rewrite guide" }).click();
  await expect(page.getByText("The guide could not be written.")).toBeVisible();
  await expect(page.getByText("The return value changed.")).toBeVisible();
});
