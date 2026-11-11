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
  await expect(page.locator("[data-home-chief]")).toHaveText("Chief of Staff");

  await page.getByLabel("Ask").fill("how is EXO going?");
  await page.getByRole("button", { name: "Send" }).click();
  // Dropwave (Ash, 11 Nov): the box starts the conversation. The words go to the Chief of Staff's own chat, which
  // opens, and the conversation carries on there, not in a second copy on Home.
  await expect(page.locator("body")).toHaveAttribute("data-chief-heard", "how is EXO going?");
  await expect(page.locator("body")).toHaveAttribute("data-mono-chat", /.+/);
  const opened = await page.locator("body").getAttribute("data-mono-chat");
  expect(opened).toBeTruthy();
  expect(opened).not.toBe("coordinator");
  await expect(page.locator("[data-home-you]")).toHaveCount(0);
  await expect(page.locator("body")).toHaveAttribute("data-tasks-created", "0");
});
