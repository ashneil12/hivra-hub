import { expect, test } from "@playwright/test";

test("max builders and the pauses can each be turned, and running work is left alone", async ({ page }) => {
  await page.goto("/tests/browser/wp161-builder-scale.html");
  const system = page.locator('[data-builder-scale="system"]');
  const project = page.locator("[data-project-workers-dialog]");

  await expect(system.getByText("Max builders", { exact: true })).toBeVisible();
  await expect(system.getByText("Projects that have not set their own use this. The default is 6.")).toBeVisible();
  await expect(system.getByText("Pause new builders when")).toBeVisible();
  await expect(system.getByText("Running builders keep going. Each check can be turned off.")).toBeVisible();
  await expect(project.getByLabel("Max builders")).toBeVisible();
  await expect(project.getByText("Pause new builders when")).toBeVisible();

  await system.locator("[data-builder-max]").fill("20");
  await expect(system.locator("[data-builder-scale-line]")).toContainText("1.6 times the number of cores");
  // The project field is its own ceiling. Raising the shared max does not rewrite it.
  await expect(project.locator("[data-project-workers='workers']")).toHaveValue("6");

  await system.locator("[data-builder-pause-on='load']").uncheck();
  await expect(system.locator("[data-builder-scale-line]")).toContainText("Load is not checked.");
  await system.locator("[data-builder-pause-on='memory']").check();
  await expect(system.locator("[data-builder-scale-line]")).toContainText("below 2 GB");
  await system.locator("[data-builder-pause='memory']").fill("3");
  await expect(system.locator("[data-builder-scale-line]")).toContainText("below 3 GB");
  await system.locator("[data-builder-pause-on='disk']").check();
  await expect(system.locator("[data-builder-scale-line]")).toContainText("below 5 GB");

  const line = await system.locator("[data-builder-scale-line]").innerText();
  expect(line).not.toMatch(/[—–]/);
  expect(line).toContain("Running builders keep going.");
});
