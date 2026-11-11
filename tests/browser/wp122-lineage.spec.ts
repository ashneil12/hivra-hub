import { expect, test } from "@playwright/test";

test("the subagent list on the parent thread", async ({ page }) => {
  await page.goto("/tests/browser/wp122-lineage.html");
  const list = page.locator("#list");
  // It opens as one line: what the children are doing, and nothing else until the reader asks.
  await expect(list.locator("[data-lineage-summary]")).toHaveText("1 done, 1 failed");
  await expect(list.locator("[data-lineage-child]")).toHaveCount(0);
  const toggle = list.getByRole("button", { name: /Subagents/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const done = list.locator("[data-lineage-child='toolu_agent']");
  await expect(done.locator("[data-lineage-name]")).toHaveText("Explore the auth module");
  await expect(done.locator("[data-lineage-role]")).toHaveText("explore");
  await expect(done.locator("[data-lineage-model]")).toHaveText("claude-haiku-5");
  await expect(done.locator("[data-lineage-status]")).toHaveText("Done");
  await expect(done.locator("[data-lineage-outcome='result']")).toHaveText("Auth lives in src/auth.");
  await expect(done.getByRole("button")).toHaveCount(0);

  const failed = list.locator("[data-lineage-child='toolu_fail']");
  await expect(failed.locator("[data-lineage-status]")).toHaveText("Failed");
  await expect(failed.locator("[data-lineage-outcome='error']")).toHaveText("The model name was unknown.");
  await expect(failed.getByRole("button")).toHaveCount(0);

  const unreported = page.locator("#unreported");
  await expect(unreported.locator("[data-lineage-unreported]")).toHaveText("Not reported by this CLI");
  await expect(unreported.locator("[data-lineage-child]")).toHaveCount(0);
  await expect(page.locator("#empty [data-lineage]")).toHaveCount(0);

  const approval = page.locator("#approval [data-child-approval]");
  await expect(approval).toContainText("Approval needed from Explore the auth module");
  await expect(approval.locator("[data-child-approval-detail]")).toHaveText("Read the config file");

  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Open the transcript");
  expect(body).not.toContain("—");
  expect(body).not.toContain("–");
});
