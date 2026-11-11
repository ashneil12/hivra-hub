import { expect, test } from "@playwright/test";

const WARNING =
  "Hivra only runs this while it is open. If Hivra is closed at this time, the run is missed.";
const MISSED =
  'A scheduled prompt was missed because Hivra was closed. "Check the build" was set for 2099-01-02 09:00.';

test("a one-time schedule says a closed app will miss it, and can be cancelled", async ({
  page,
}) => {
  await page.goto("/tests/browser/wp128-one-time-schedule.html");

  await expect(page.getByLabel("Missed schedules")).toContainText(MISSED);
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.getByLabel("Missed schedules")).toHaveCount(0);

  await page.getByText("Run once").click();
  await page.getByLabel("Prompt").fill("Check the build once");
  await page.getByLabel("When").fill("2099-01-01T09:00");
  await page.getByRole("button", { name: "Schedule" }).click();

  const dialog = page.getByRole("dialog", { name: "Schedule this prompt" });
  await expect(dialog).toContainText(WARNING);
  await expect(dialog).toContainText("2099-01-01 09:00");
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("[data-one-time-list]")).toHaveCount(0);

  await page.getByRole("button", { name: "Schedule" }).click();
  await dialog.getByRole("button", { name: "Schedule" }).click();
  await expect(page.locator("[data-one-time-list]")).toContainText("Check the build once");
  await expect(page.locator("[data-one-time-list]")).toContainText("Scheduled");

  await page.reload();
  await expect(page.locator("[data-one-time-list]")).toContainText("Check the build once");
  await expect(page.locator("[data-one-time-list]")).toContainText("Scheduled");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-one-time-list]")).toContainText("Cancelled");
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
