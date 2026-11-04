import { statSync } from "node:fs";
import { expect, test } from "@playwright/test";

// WP-42. What a person sees: Verify is offered, and nothing installs until they say so.
test.use({ viewport: { width: 960, height: 900 } });

type Call = { command: string; args: { source?: { package?: string }; requestedBy?: { kind?: string }; revision?: number } };

function calls(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as unknown as { verifyCalls: () => Call[] }).verifyCalls());
}

test("Verify is offered for a web project and Install waits for a yes", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/verify-offer.html");
  await expect(page.locator("[data-verify-sentence]")).toHaveText("This project looks like a web app.");
  await expect(page.locator("[data-verify-note]")).toContainText("Install needs your OK.");
  const before = await calls(page);
  expect(before.map((call) => call.command)).not.toContain("plugins_install");

  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.locator("[data-verify-status]")).toHaveText("Waiting for your OK in the Inbox");
  const after = await calls(page);
  const install = after.find((call) => call.command === "plugins_install");
  expect(install?.args.source?.package).toBe("e2e");
  expect(install?.args.requestedBy).toEqual({ kind: "person" });

  const shot = testInfo.outputPath(`verify-offer-${testInfo.project.name}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  expect(statSync(shot).size).toBeGreaterThan(2000);
});

test("Not now remembers the no and the offer goes away", async ({ page }) => {
  await page.goto("/tests/browser/verify-offer.html");
  await expect(page.locator("[data-verify-offer]")).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("[data-verify-offer]")).toHaveCount(0);
  const decline = (await calls(page)).find((call) => call.command === "plugins_verify_decline");
  expect(decline?.args.revision).toBe(2);
});
