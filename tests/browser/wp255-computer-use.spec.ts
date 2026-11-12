import { expect, test } from "@playwright/test";

type Call = { command: string; args: unknown };
const calls = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __wp255Calls: Call[] }).__wp255Calls);

test("computer use is off by default and says how to install its helper", async ({ page }) => {
  await page.goto("/tests/browser/wp255-computer-use.html");
  const sw = page.getByRole("switch", { name: "Computer use" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-setting-id='computer-use']")).toContainText("npm i -g open-computer-use");
  await expect(page.getByRole("radiogroup", { name: "What chats may do" })).toHaveCount(0);
});

test("turning it on shows look only first, then look and use, the chats with their own say and the activity", async ({ page }) => {
  await page.goto("/tests/browser/wp255-computer-use.html?installed");
  const row = page.locator("[data-setting-id='computer-use']");
  await page.getByRole("switch", { name: "Computer use" }).click();
  await expect(page.getByRole("radio", { name: "Look only" })).toHaveAttribute("aria-checked", "true");
  expect(await calls(page)).toContainEqual({
    command: "computer_use_put",
    args: { change: { enabled: true, mode: "observe", allowedApps: [], allowCoordinates: false } },
  });
  await expect(page.getByRole("switch", { name: "Click by position" })).toHaveCount(0);

  await page.getByRole("radio", { name: "Look and use" }).click();
  await expect(page.getByRole("switch", { name: "Click by position" })).toHaveAttribute("aria-checked", "false");

  await page.getByLabel("Allowed apps").fill("Notes, Safari, notes");
  await page.getByLabel("Allowed apps").blur();
  await expect.poll(async () => (await calls(page)).filter((c) => c.command === "computer_use_put").length).toBe(3);
  const last = (await calls(page)).filter((c) => c.command === "computer_use_put").at(-1);
  expect(last?.args).toEqual({ change: { enabled: true, mode: "control", allowedApps: ["Notes", "Safari"], allowCoordinates: false } });

  await expect(row).toContainText("Look only in this chat");
  await expect(row.getByRole("list", { name: "Computer use activity" })).toContainText("1Password");
  await expect(row.getByRole("list", { name: "Computer use activity" })).toContainText("refused");

  await page.getByRole("button", { name: "Check setup" }).click();
  await expect(row).toContainText("Screen Recording: granted");

  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/[—–]/);
  expect(text).not.toContain("/Users/");
});
