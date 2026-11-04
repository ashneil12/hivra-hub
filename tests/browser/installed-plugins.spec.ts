import { expect, test } from "@playwright/test";

test("installed plugins update, roll back and remove", async ({ page }) => {
  await page.goto("/tests/browser/installed-plugins.html");
  const list = page.getByRole("list", { name: "Installed plugins" });
  const demo = list.locator("[data-plugin=demo]");
  const solo = list.locator("[data-plugin=solo]");
  await expect(demo).toHaveAttribute("data-version", "1.0.0");
  await expect(solo).toHaveAttribute("data-version", "2.0.0");
  await expect(solo.getByRole("button", { name: "Roll back" })).toHaveCount(0);

  const off = solo.getByRole("switch", { name: "Turn solo on" });
  await expect(off).toHaveAttribute("aria-checked", "false");
  await off.click();
  await expect(solo.getByRole("switch", { name: "Turn solo off" })).toHaveAttribute("aria-checked", "true");
  await expect(solo).toContainText('a skill called "one" is already there');
  await expect(page.locator("body")).toHaveAttribute(
    "data-last-switch",
    JSON.stringify({ command: "plugins_enable", name: "solo" }),
  );
  await solo.getByRole("switch", { name: "Turn solo off" }).click();
  await expect(solo.getByRole("switch", { name: "Turn solo on" })).toHaveAttribute("aria-checked", "false");
  await expect(solo).not.toContainText("already there");
  await expect(page.locator("body")).toHaveAttribute(
    "data-last-switch",
    JSON.stringify({ command: "plugins_disable", name: "solo" }),
  );

  await demo.getByRole("button", { name: "Roll back" }).click();
  await expect(demo).toHaveAttribute("data-version", "0.9.0");
  await expect(demo.getByRole("button", { name: "Roll back" })).toHaveCount(0);

  await solo.getByRole("button", { name: "Remove" }).click();
  await expect(solo).toHaveCount(0);
  await expect(demo).toHaveAttribute("data-version", "0.9.0");

  await demo.getByRole("button", { name: "Update" }).click();
  await demo.getByLabel("Exact version").fill("1.2.3");
  await demo.getByRole("button", { name: "Install this version" }).click();
  await expect(demo).toHaveAttribute("data-version", "1.2.3");
  await expect(page.locator("body")).toHaveAttribute(
    "data-last-update",
    JSON.stringify({ kind: "npm", package: "demo-plugin", version: "1.2.3" }),
  );
});
