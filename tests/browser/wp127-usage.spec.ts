import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp127-usage.html";

test("keeps the open chat's one context ring in view while the thread scrolls", async ({ page }) => {
  await page.goto(pageUrl);
  const pane = page.locator("[data-session-drop]");
  const scroller = pane.locator(".agent-transcript");
  const meter = pane.getByRole("img", { name: /26% context used/ });

  await expect(scroller).toBeVisible();
  // One ring, not a second "Context" row above the composer.
  await expect(pane.getByRole("img", { name: /context used/ })).toHaveCount(1);
  await expect(meter).toBeVisible();
  expect(await meter.evaluate((element) => element.closest(".agent-transcript") === null)).toBe(true);
  await expect(pane.getByText("Context", { exact: true })).toHaveCount(0);

  const before = await meter.boundingBox();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(meter).toBeVisible();
  const after = await meter.boundingBox();
  expect(before && after && Math.abs(before.y - after.y) < 1).toBe(true);
});

test("filters usage by provider and model, and labels a dollar figure", async ({ page }) => {
  await page.goto(pageUrl);
  const usage = page.locator("#usage");
  const provider = usage.getByLabel("Provider");
  const model = usage.getByLabel("Model");

  await expect(provider).toHaveValue("");
  await expect(model).toHaveValue("");
  await expect(usage.getByRole("table", { name: "By model" })).toContainText("sonnet-5");
  await expect(usage.getByRole("table", { name: "By model" })).toContainText("gpt-5");
  await expect(usage).toContainText("$0.50 (estimated, not your bill)");
  await expect(usage).not.toContainText("hunter2");
  await expect(usage).not.toContainText("must not travel");

  await provider.selectOption("codex");
  await expect(usage.getByRole("table", { name: "By model" })).toContainText("gpt-5");
  await expect(usage.getByRole("table", { name: "By model" })).not.toContainText("sonnet-5");
  await expect(model.locator("option")).toHaveText(["All", "gpt-5"]);

  await provider.selectOption({ label: "All" });
  await model.selectOption("sonnet-5");
  await expect(usage.getByRole("table", { name: "By model" })).toContainText("sonnet-5");
  await expect(usage.getByRole("table", { name: "By model" })).not.toContainText("gpt-5");

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
