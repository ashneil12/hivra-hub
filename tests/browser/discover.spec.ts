import { statSync } from "node:fs";
import { expect, test } from "@playwright/test";

// WP-32. What a person sees: search, a filter, the detail, and Install. Listing never runs a plugin.
test.use({ viewport: { width: 960, height: 900 } });

test("Discover lists plugins, and Install is only offered for one that can be installed", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/discover.html");
  await expect(page.locator('[data-plugin="pstack"]')).toBeVisible();
  await expect(page.locator("[data-licence]")).toHaveText("MIT");
  await expect(page.locator("[data-source]")).toContainText("6ea7458");
  await expect(page.locator("[data-adds]")).toContainText("58 skills");
  await expect(page.locator("[data-permissions]")).toContainText("Reads the repository");
  await expect(page.locator("[data-install]")).toBeVisible();

  const before = await page.evaluate(() => (window as unknown as { discoverCalls: () => { command: string }[] }).discoverCalls());
  expect(before.map((call) => call.command)).toEqual(["plugins_discover"]);

  await page.getByRole("button", { name: "MCP servers" }).click();
  await expect(page.locator('[data-plugin="browser"]')).toBeVisible();
  await expect(page.locator('[data-plugin="pstack"]')).toHaveCount(0);
  await expect(page.locator("[data-install]")).toHaveCount(0);

  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search plugins").fill("lauren");
  await expect(page.locator('[data-plugin="pstack"]')).toBeVisible();
  await expect(page.locator('[data-plugin="browser"]')).toHaveCount(0);

  await page.getByLabel("Search plugins").fill("");
  await expect(page.locator('[data-plugin="pstack"]')).toBeVisible();
  await expect(page.locator("[data-index-error]")).toContainText("The index didn't answer.");
  await expect(page.locator("[data-index-error]")).not.toContainText("Not compatible");

  const listShot = testInfo.outputPath(`discover-${testInfo.project.name}-list.png`);
  await page.screenshot({ path: listShot, fullPage: true });
  expect(statSync(listShot).size).toBeGreaterThan(2000);

  await page.locator('[data-plugin="dsh-only"]').click();
  await expect(page.locator('[data-plugin="dsh-only"]')).toHaveAttribute("data-status", "not-compatible");
  await expect(page.locator("[data-detail]")).toContainText("DeepSeek Harness");
  await expect(page.locator("[data-install]")).toHaveCount(0);

  await page.locator('[data-plugin="pstack"]').click();
  await page.locator("[data-install]").click();
  await expect(page.locator("[data-installed]")).toHaveText(
    "Installed pstack. It's off until you switch it on in Settings > Plugins.",
  );
  const after = await page.evaluate(() => (window as unknown as { discoverCalls: () => { command: string; args: { source?: { commit?: string }; requestedBy?: { kind?: string } } }[] }).discoverCalls());
  expect(after.map((call) => call.command)).toEqual(["plugins_discover", "plugins_install"]);
  expect(after[1]?.args.source?.commit).toBe("6ea74587e384e1a8035c09ae33a46fe3f881eb9b");
  expect(after[1]?.args.requestedBy).toEqual({ kind: "person" });

  const detailShot = testInfo.outputPath(`discover-${testInfo.project.name}-detail.png`);
  await page.screenshot({ path: detailShot, fullPage: true });
  expect(statSync(detailShot).size).toBeGreaterThan(2000);
});
