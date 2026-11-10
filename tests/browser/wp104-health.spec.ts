import { expect, test } from "@playwright/test";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
const HOME = "/Users/ada";

test("the health list shows what to check, and the copy masks a planted key", async ({ page }) => {
  await page.goto("/tests/browser/wp104-health.html");

  const list = page.locator("[data-health]");
  await expect(list.getByText("OK. Git is installed (git version 2.39.2).")).toBeVisible();
  await expect(list.getByText("Check this. Less than 2 GB is free. Free some space before a long run.")).toBeVisible();
  await expect(list.getByText("Check this. Couldn't reach Ollama this time. It will be checked again shortly.")).toBeVisible();
  await expect(list.getByText("Problem. The app database failed its check. Copy diagnostics before you keep working.")).toBeVisible();
  await expect(list).toContainText(KEY);
  await expect(list).toContainText(HOME);

  await list.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(list.getByRole("status")).toHaveText("Copied. Paste it into a message.");

  const copied = await page.locator("[data-copied]").textContent();
  expect(copied).toContain("Git is installed (git version 2.39.2).");
  expect(copied).toContain("Less than 2 GB is free.");
  expect(copied).toContain("[secret removed]");
  expect(copied).toContain("~");
  expect(copied).not.toContain(KEY);
  expect(copied).not.toContain(HOME);
});

test("a late check does not replace a newer one", async ({ page }) => {
  await page.goto("/tests/browser/wp104-health.html");

  const late = page.locator("[data-late]");
  await expect(late.getByText("OK. Git is installed (git version 2.39.2).")).toBeVisible();
  await expect(late.getByText("OK. The app database looks fine.")).toBeVisible();
  await expect(late).not.toContainText("not installed");

  await late.getByRole("button", { name: "Release the late check" }).click();
  await expect(late.getByText("OK. The app database looks fine.")).toBeVisible();
  await expect(late).not.toContainText("not installed");
  await expect(late).not.toContainText("failed its check");
});
