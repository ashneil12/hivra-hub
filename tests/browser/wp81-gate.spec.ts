import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp81-gate.html";

test("the check starts off, and turning it on shows what it did", async ({ page }) => {
  await page.goto(pageUrl);
  const toggle = page.getByRole("switch", { name: "Check work before it goes to GitHub" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Added the no-mistakes remote.")).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-last-command", "gate_setting_set");
});

test("a running check, a parked question and a passed pull request are on the card", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByText("checking: tests")).toBeVisible();
  await expect(page.getByText("The name change needs a look.")).toBeVisible();
  await expect(page.getByText("https://github.com/acme/web/pull/7")).toBeVisible();
});

test("approve, fix and skip each go back as the answer", async ({ page }) => {
  await page.goto(pageUrl);
  for (const answer of ["Approve", "Fix", "Skip"]) {
    await page.getByRole("button", { name: answer, exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-last-answer", answer);
  }
});

test("a late reply for the previous project does not overwrite the current one", async ({ page }) => {
  await page.goto(pageUrl);
  await page.getByRole("button", { name: "Slow project" }).click();
  await page.getByRole("button", { name: "Other project" }).click();
  await expect(page.getByText("This project is off.")).toBeVisible();
  await expect(page.getByText("checking: tests")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { releaseStale: () => void }).releaseStale());
  await expect(page.getByRole("switch", { name: "Check work before it goes to GitHub" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByText("This project is off.")).toBeVisible();
  await expect(page.getByText("Stale note.")).toHaveCount(0);
  await expect(page.getByText("Old card.")).toHaveCount(0);
});

test("a failed load keeps the last cards", async ({ page }) => {
  await page.goto(pageUrl);
  await expect(page.getByText("checking: tests")).toBeVisible();
  await page.getByRole("button", { name: "Broken project" }).click();
  await expect(page.getByText("That didn't go through. Try again.")).toBeVisible();
  await expect(page.getByText("checking: tests")).toBeVisible();
});
