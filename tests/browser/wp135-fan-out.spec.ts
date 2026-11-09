import { expect, test } from "@playwright/test";

test("the composer can compare one prompt on up to four models", async ({ page }) => {
  await page.goto("/tests/browser/wp135-fan-out.html");

  await page.getByRole("button", { name: "Compare models" }).click();
  await expect(page.locator("[data-fan-out-cap]")).toContainText("You can compare up to 4 models.");

  await page.getByRole("checkbox", { name: "Claude: one" }).check();
  await page.getByRole("checkbox", { name: "Codex: two" }).check();
  await page.getByRole("checkbox", { name: "Cursor: three" }).check();
  await page.getByRole("checkbox", { name: "Pi: four" }).check();
  await expect(page.getByRole("checkbox", { name: "Hermes: five" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Hermes: five" })).not.toBeChecked();

  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.locator("[data-fan-out-paid]")).toContainText("Each chat can use a paid turn.");
  await expect(page.locator("[data-fan-out-paid]")).toContainText("4");

  await page.getByRole("button", { name: "Start chats" }).click();
  await expect(page.locator("[data-fan-out-started]")).toHaveText("Started 4 chats");
  await expect(page.locator("[data-fan-out-panel]")).toHaveCount(0);

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
