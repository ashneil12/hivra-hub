import { expect, test } from "@playwright/test";

test("the subagent list on the parent thread", async ({ page }) => {
  await page.goto("/tests/browser/wp122-lineage.html");
  const list = page.locator("#list");
  const done = list.locator("[data-lineage-child='toolu_agent']");
  await expect(done.locator("[data-lineage-name]")).toHaveText("Explore the auth module");
  await expect(done.locator("[data-lineage-role]")).toHaveText("explore");
  await expect(done.locator("[data-lineage-model]")).toHaveText("claude-haiku-5");
  await expect(done.locator("[data-lineage-status]")).toHaveText("Done");
  await expect(done.locator("[data-lineage-outcome='result']")).toHaveText("Auth lives in src/auth.");
  await done.getByRole("button", { name: "Open the transcript" }).click();
  await expect(list.locator("[data-opened]")).toHaveText("hivra-9");

  const failed = list.locator("[data-lineage-child='toolu_fail']");
  await expect(failed.locator("[data-lineage-status]")).toHaveText("Failed");
  await expect(failed.locator("[data-lineage-outcome='error']")).toHaveText("The model name was unknown.");
  await expect(failed.getByRole("button", { name: "Open the transcript" })).toHaveCount(0);

  const unreported = page.locator("#unreported");
  await expect(unreported.locator("[data-lineage-unreported]")).toHaveText("Not reported by this CLI");
  await expect(unreported.locator("[data-lineage-child]")).toHaveCount(0);
  await expect(page.locator("#empty [data-lineage]")).toHaveCount(0);

  const body = await page.locator("body").innerText();
  expect(body).not.toContain("—");
  expect(body).not.toContain("–");
});
