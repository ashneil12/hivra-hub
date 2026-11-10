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
  // The pauses are one setting for every project, and both places say so.
  await expect(system.getByText("These pauses apply to all projects.")).toBeVisible();
  await expect(project.getByText("These pauses apply to all projects.")).toBeVisible();

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
  // The disk pause is on by default at 30 GB, in both places, and the person can turn it off or change it.
  await expect(system.locator("[data-builder-pause-on='disk']")).toBeChecked();
  await expect(system.locator("[data-builder-pause='disk']")).toHaveValue("30");
  await expect(project.locator("[data-builder-pause-on='disk']")).toBeChecked();
  await expect(system.locator("[data-builder-scale-line]")).toContainText("New builders pause when free disk is below 30 GB.");
  await system.locator("[data-builder-pause-on='disk']").uncheck();
  await expect(system.locator("[data-builder-scale-line]")).toContainText("Free disk is not checked.");
  await system.locator("[data-builder-pause-on='disk']").check();
  await expect(system.locator("[data-builder-pause='disk']")).toHaveValue("30");
  await system.locator("[data-builder-pause='disk']").fill("40");
  await expect(system.locator("[data-builder-scale-line]")).toContainText("free disk is below 40 GB");

  const line = await system.locator("[data-builder-scale-line]").innerText();
  expect(line).not.toMatch(/[—–]/);
  expect(line).toContain("Running builders keep going.");
});
