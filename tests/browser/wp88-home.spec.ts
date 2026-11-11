import { expect, test } from "@playwright/test";

// WP-88. The chief's own chat answers on Home. It does not file a task.
test.use({ viewport: { width: 1100, height: 760 } });

test("the chief chat answers across two projects and files nothing", async ({ page }) => {
  await page.goto("/tests/browser/wp88-home.html");
  await expect(page.locator("[data-home-header]")).toBeVisible();
  await expect(page.locator("[data-home-start]")).toBeVisible();
  await expect(page.locator("[data-home] [data-home-header]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Start a chat with Crew" })).toHaveCount(0);
  await expect(page.locator("[data-home-scope]")).toHaveText("read all 2 projects");
  await expect(page.locator("[data-home-chief]")).toHaveText("Coordinator");

  await page.getByLabel("Ask").fill("how is EXO going?");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.locator("[data-home-reply]");
  await expect(reply).toContainText("how is EXO going?");
  await expect(reply).toContainText("EXO is fine.");
  await expect(page.locator("body")).toHaveAttribute("data-tasks-created", "0");

  await page.getByRole("button", { name: "Open full chat" }).click();
  const opened = await page.locator("body").getAttribute("data-mono-chat");
  expect(opened).toBeTruthy();
  expect(opened).not.toBe("coordinator");
  await expect(page.locator("body")).toHaveAttribute("data-tasks-created", "0");
});
