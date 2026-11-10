import { expect, test, type Page } from "@playwright/test";

const pageUrl = "/tests/browser/wp132-review-guide.html";
const call = (page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([fn, rest]) => (window as unknown as Record<string, (...a: unknown[]) => void>)[fn as string](...(rest as unknown[])),
    [name, args] as const,
  );

test("nothing is written until asked, and a stop jumps to its lines", async ({ page }) => {
  await page.goto(pageUrl);
  const guide = page.getByRole("region", { name: "Guide" });
  await expect(guide.getByText("never posted to GitHub")).toBeVisible();
  await expect(page.locator("body")).not.toHaveAttribute("data-runs", /.+/);
  await guide.getByRole("button", { name: "Write guide" }).click();
  await expect(guide.getByText("Moves the check into the second file.")).toBeVisible();
  await expect(guide.getByText("Look closely")).toBeVisible();
  await expect(guide.getByRole("group", { name: "Mechanical files" })).toContainText("package-lock.json");

  const target = page.getByText("target src/second.ts 400");
  await expect(target).toHaveCount(0);
  await guide.getByRole("button", { name: /The new check/ }).click();
  await expect(target).toBeInViewport();

  // The guide lives in the app's own store; the only commands are its reads and writes.
  await expect(page.locator("body")).toHaveAttribute(
    "data-commands",
    "plugin:hub|local_hub_read,plugin:hub|local_hub_write",
  );
});

test("a new push shows the guide as written for another version until it is rewritten", async ({ page }) => {
  await page.goto(pageUrl);
  const guide = page.getByRole("region", { name: "Guide" });
  await guide.getByRole("button", { name: "Write guide" }).click();
  await expect(guide.getByRole("list", { name: "Guide stops" })).toBeVisible();
  await page.getByRole("button", { name: "New push" }).click();
  await expect(guide.getByText("This guide was written for another version of this pull request.")).toBeVisible();
  await expect(guide.getByRole("list", { name: "Guide stops" })).toHaveCount(0);
  await guide.getByRole("button", { name: "Rewrite guide" }).click();
  await expect(guide.getByRole("list", { name: "Guide stops" })).toBeVisible();
  await expect(guide.getByText("This guide was written for another version of this pull request.")).toHaveCount(0);
});

test("a failed write keeps the guide that was there", async ({ page }) => {
  await page.goto(pageUrl);
  const guide = page.getByRole("region", { name: "Guide" });
  await guide.getByRole("button", { name: "Write guide" }).click();
  await expect(guide.getByText("Moves the check into the second file.")).toBeVisible();
  await call(page, "setWriterMode", "fail");
  await guide.getByRole("button", { name: "Rewrite guide" }).click();
  await expect(guide.getByRole("alert")).toHaveText("The model took too long. The guide was not changed.");
  await expect(guide.getByText("Moves the check into the second file.")).toBeVisible();
});

test("a late answer does not overwrite a guide another window kept first", async ({ page }) => {
  await page.goto(pageUrl);
  const guide = page.getByRole("region", { name: "Guide" });
  await expect(guide.getByRole("button", { name: "Write guide" })).toBeEnabled();
  await call(page, "setWriterMode", "hold");
  await guide.getByRole("button", { name: "Write guide" }).click();
  await expect(guide.getByRole("button", { name: "Writing guide" })).toBeDisabled();
  await expect(page.locator("body")).toHaveAttribute("data-pending", "1");
  await call(page, "otherWindowWrites", "The other window's guide.");
  await expect(guide.getByText("The other window's guide.")).toBeVisible();
  await call(page, "releaseAnswer");
  await expect(guide.getByRole("status")).toHaveText("Another window wrote a guide first. Showing that one.");
  await expect(guide.getByText("The other window's guide.")).toBeVisible();
  await expect(guide.getByText("Moves the check into the second file.")).toHaveCount(0);
});
