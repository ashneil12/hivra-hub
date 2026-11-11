import { expect, test } from "@playwright/test";

test("a refused secret names its line, and one click allows that line", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  await expect(page.getByText("Blocked: a possible secret is on line 12 of src/config.rs in /srv/project (commit 1a2b3c4d5e6f).")).toBeVisible();
  await expect(page.getByText("The value is not shown.").first()).toBeVisible();
  await page.getByRole("button", { name: "Allow this line" }).first().click();
  await expect(page.getByText("Allowed. The next push checks this line again and lets it through.")).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __allowCalls: unknown[] }).__allowCalls);
  expect(calls).toEqual([{ id: "0123456789ab" }]);
});

test("a commit message finding, and a refusal the app holds no record of, have no allow button", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  await expect(page.getByText("Possible secret in a commit message:2.")).toBeVisible();
  await expect(page.getByText("This refusal is no longer on record, so it cannot be allowed here.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow this line" })).toHaveCount(1);
});

test("a tracked approvals file is refused as a whole file, and Allow keeps it in that repository only (WP-248)", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  await expect(
    page.getByText("Blocked: .claude/settings.local.json in /srv/project is an agent's saved approvals, and this repository tracks it."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Allow this file in this repository" }).click();
  await expect(page.getByText("Allowed. This repository may keep this file; its lines are still checked for secrets.")).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __allowCalls: unknown[] }).__allowCalls);
  expect(calls).toEqual([{ id: "bbbbbbbbbbbb" }]);
});

test("Settings lists the allowed lines, and Remove takes one out", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  await expect(page.getByRole("heading", { name: "Allowed lines (secret check)" })).toBeVisible();
  await expect(page.locator("[data-allow-row]")).toHaveCount(2);
  await page.locator("[data-allow-row]").first().getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("[data-allow-row]")).toHaveCount(1);
  await expect(page.getByText("src/fixture.rs")).toBeVisible();
});

test("the guard's words use no em or en dashes", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/[\u2013\u2014]/);
});

test("a card's link hands the refusal to the source-control panel", async ({ page }) => {
  await page.goto("/tests/browser/commit-guard.html");
  await page.getByRole("button", { name: "Open in source control" }).click();
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(opened).toEqual(["Possible secret in src/config.rs:12 in /srv/project (commit 1a2b3c4d5e6f, refusal 0123456789ab). The value is not shown."]);
});
