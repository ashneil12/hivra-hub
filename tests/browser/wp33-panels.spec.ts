import { expect, test } from "@playwright/test";
import fs from "node:fs";

// WP-33 proof (the panels strip in a browser, not Ash's Mac; made-up data labelled Example:): a panel from a plugin
// renders in the sandbox with only the permission it asked for, and turning the plugin off removes its tab.
const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/wp33";

test("a panel renders in the sandbox and leaves when its plugin is turned off", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/tests/browser/wp33-panels.html");
  await expect(page.getByRole("heading", { name: "My panels" })).toBeVisible();
  await page.getByRole("button", { name: "Open Example: board" }).click();

  const tab = page.locator("[data-panel-tab]");
  await expect(tab).toHaveAttribute("data-panel-plugin", "my-panels");
  await expect(tab).toHaveAttribute("data-panel-grants", "tasks.read");
  const frame = tab.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("srcdoc", /connect-src 'none'/);
  await expect(frame).toHaveAttribute("srcdoc", /Example: board/);
  await page.screenshot({ path: `${SHOTS}/wp33-panel.png` });

  await page.locator("[data-panel-turn-off='my-panels']").click();
  await expect(page.locator("[data-panel-tab]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/wp33-off.png` });
});
