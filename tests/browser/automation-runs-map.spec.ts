import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/automation-runs-map.html";

test("shows seeded runs, a live run, and a filter", async ({ page, browserName }) => {
  await page.goto(pageUrl);
  await page.getByRole("tab", { name: "Runs" }).click();
  const runs = page.locator("[data-automation-runs]");
  await expect(runs.getByText("Morning audit. Started by the 9:00 schedule.")).toBeVisible();
  await expect(runs.getByText("Morning audit. Finished. Started by the 9:00 schedule.")).toBeVisible();
  await expect(runs.getByText("Failed: the Claude login has expired")).toBeVisible();
  await expect(runs.getByText("PROMPT_SHOULD_NOT_LEAK")).toHaveCount(0);

  await page.evaluate(() => {
    (window as unknown as { __wp180aEmit: () => void }).__wp180aEmit();
  });
  await expect(runs.getByText("Nightly. Started by the hourly schedule.")).toBeVisible();

  await runs
    .getByRole("button", { name: /Morning audit\. Started by the 9:00 schedule/ })
    .click();
  await expect(page.locator("#opened")).toHaveText("chat-1");

  if (browserName === "chromium") {
    await page.screenshot({
      path: "docs/hivra/work/proofs/wp-180a/runs.png",
      fullPage: true,
    });
  }

  await runs.getByRole("combobox", { name: "Automation" }).selectOption({ label: "Inbox watch" });
  await expect(runs.getByRole("listitem")).toHaveCount(1);
  await expect(runs.getByText("the Claude login has expired")).toBeVisible();
  await expect(runs.getByText("the 9:00 schedule")).toHaveCount(0);

  await runs.getByRole("combobox", { name: "Automation" }).selectOption({ label: "All automations" });
  await runs.getByRole("combobox", { name: "Result" }).selectOption({ label: "Finished" });
  await expect(runs.getByRole("listitem")).toHaveCount(1);
  await expect(runs.getByRole("listitem")).toContainText("Finished");
  await expect(runs.getByText("the Claude login has expired")).toHaveCount(0);
});

test("draws the seeded map and a node opens the editor", async ({ page, browserName }) => {
  await page.goto(pageUrl);
  await page.getByRole("tab", { name: "Automations" }).focus();
  await page.keyboard.press("ArrowRight");
  const runsTab = page.getByRole("tab", { name: "Runs" });
  await expect(runsTab).toHaveAttribute("aria-selected", "true");
  const runsPanel = await runsTab.getAttribute("aria-controls");
  expect(runsPanel).toBeTruthy();
  await expect(page.locator(`#${runsPanel}`)).toHaveAttribute("role", "tabpanel");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Map" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Map" }).click();
  const map = page.locator("[data-automation-map]");
  await expect(map.locator('[data-to="Morning audit"]')).toHaveCount(2);
  await expect(map.locator('[data-from="A new issue in owner/repo"]')).toHaveCount(2);
  await expect(map.locator('[data-node="automation"][data-disabled="true"]')).toHaveCount(1);
  await expect(map.getByRole("button", { name: "Inbox watch, off" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(map.getByText("PROMPT_SHOULD_NOT_LEAK")).toHaveCount(0);

  if (browserName === "chromium") {
    await page.screenshot({
      path: "docs/hivra/work/proofs/wp-180a/map.png",
      fullPage: true,
    });
  }

  await map.getByRole("button", { name: "Morning audit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Automation name" })).toHaveValue(
    "Morning audit",
  );
});
