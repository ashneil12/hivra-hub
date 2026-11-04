import { expect, test } from "@playwright/test";

test("stop ends the browser that is showing and leaves the other", async ({ page }) => {
  await page.goto("/tests/browser/browser-plugin.html");
  const bar = page.getByRole("region", { name: "Browser in use" });
  await expect(bar).toContainText("Ada is using the browser");
  await expect(bar).toContainText("Milo is using the browser");
  await expect(bar.getByRole("button", { name: "Stop all" })).toBeVisible();

  await bar.locator("[data-drive=drive-ada]").getByRole("button", { name: "Stop" }).click();
  await expect(bar).not.toContainText("Ada is using the browser");
  await expect(bar).toContainText("Milo is using the browser");
  await expect(bar.getByRole("button", { name: "Stop all" })).toHaveCount(0);

  await page.reload();
  const again = page.getByRole("region", { name: "Browser in use" });
  await expect(again).toContainText("Ada is using the browser");
  await expect(again).toContainText("Milo is using the browser");
  await again.getByRole("button", { name: "Stop all" }).click();
  await expect(again).toHaveCount(0);
});

test("each agent keeps its own profile, and a chosen folder is not deleted", async ({ page }) => {
  await page.goto("/tests/browser/browser-plugin.html");
  const list = page.getByRole("region", { name: "Browser profiles" });
  await expect(list.getByRole("heading", { name: "Browser profiles" })).toBeVisible();
  await expect(list).toContainText("Each agent keeps its own logins here, not in your browser.");
  const milo = list.locator("[data-profile=mono-milo]");
  const ada = list.locator("[data-profile=mono-ada]");
  await expect(milo).toContainText("This is a folder you chose. Clear forgets that choice and does not delete the folder.");

  const show = ada.getByRole("switch", { name: "Show the browser while Ada uses it" });
  await expect(show).toHaveAttribute("aria-checked", "false");
  await show.click();
  await expect(show).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("body")).toHaveAttribute(
    "data-watched",
    JSON.stringify({ id: "mono-ada", watch: true }),
  );

  await ada.getByRole("button", { name: "Use another folder" }).click();
  await ada.getByRole("button", { name: "Use this folder" }).click();
  await expect(ada).toContainText("Choose a folder first.");
  await expect(page.locator("body")).not.toHaveAttribute("data-chosen", /.+/);

  await ada.getByRole("textbox", { name: "Folder" }).fill("/Users/ash/browsers/ada");
  await ada.getByRole("button", { name: "Use this folder" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-chosen",
    JSON.stringify({ id: "mono-ada", path: "/Users/ash/browsers/ada" }),
  );

  await ada.getByRole("button", { name: "Clear" }).click();
  await expect(ada).toHaveCount(0);
  await expect(milo).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-deleted", "");

  await milo.getByRole("button", { name: "Clear" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-cleared", "mono-milo");
  await expect(page.locator("body")).not.toHaveAttribute("data-deleted", /milo/);
  await expect(milo).toHaveCount(0);
});

test("the row says which browser it drives", async ({ page }) => {
  await page.goto("/tests/browser/browser-plugin.html");
  const list = page.getByRole("region", { name: "Browser profiles" });
  await expect(list).toContainText("This uses Google Chrome.");
  await expect(list.getByRole("button", { name: "Get the browser" })).toHaveCount(0);

  await page.goto("/tests/browser/browser-plugin.html?chrome=missing");
  const missing = page.getByRole("region", { name: "Browser profiles" });
  await expect(missing).toContainText("Google Chrome isn't installed.");
  await missing.getByRole("button", { name: "Get the browser" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-get-browser", "1");

  await page.goto("/tests/browser/browser-plugin.html?node=missing");
  const noNode = page.getByRole("region", { name: "Browser profiles" });
  await expect(noNode).toContainText("Node couldn't be found.");
});
