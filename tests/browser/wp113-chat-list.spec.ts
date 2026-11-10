import { expect, test } from "@playwright/test";

async function order(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator("[data-chat-row]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-chat-row") ?? ""),
  );
}

test("setting off leaves the list as it is, including a settled mark", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "monocode.chatListInboxState",
      JSON.stringify({ rev: 1, chats: { alpha: { touch: 1, settledAt: 1 } } }),
    );
  });
  await page.goto("/tests/browser/wp113-chat-list.html");
  await expect(page.locator("[data-chat-row=alpha]")).toBeVisible();
  await expect(page.locator("[data-chat-row=beta]")).toBeVisible();
  expect(await order(page)).toEqual(["beta", "alpha"]);
  await expect(page.getByRole("button", { name: "Settle", exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});

test("settle, undo, snooze and unsnooze, and re-sort only while the setting is on", async ({ page }) => {
  await page.goto("/tests/browser/wp113-chat-list.html");
  expect(await order(page)).toEqual(["beta", "alpha"]);
  await page.getByRole("button", { name: "Needs you", exact: true }).click();
  expect(await order(page)).toEqual(["beta", "alpha"]);

  await page.getByRole("switch", { name: "Settle and snooze" }).click();
  expect(await order(page)).toEqual(["alpha", "beta"]);

  await page.locator("[data-chat-row=alpha]").getByRole("button", { name: "Settle", exact: true }).click();
  await expect(page.locator("[data-chat-list] [data-chat-row=alpha]")).toHaveCount(0);
  await page.locator("[data-settled-shelf]").getByRole("button", { name: /Settled/ }).click();
  await expect(page.locator("[data-settled-shelf]")).toContainText("Alpha");
  await page.locator("[data-inbox-notice]").getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("[data-chat-row=alpha]")).toBeVisible();

  await page.locator("[data-chat-row=beta]").getByRole("button", { name: "Snooze for 1 hour", exact: true }).click();
  await expect(page.locator("[data-chat-list] [data-chat-row=beta]")).toHaveCount(0);
  await page.locator("[data-snoozed-shelf]").getByRole("button", { name: /Snoozed/ }).click();
  await expect(page.locator("[data-snoozed-shelf]")).toContainText("Beta");
  await page.locator("[data-snoozed-shelf]").getByRole("button", { name: "Unsnooze", exact: true }).click();
  await expect(page.locator("[data-chat-row=beta]")).toBeVisible();

  await page.getByRole("switch", { name: "Settle and snooze" }).click();
  expect(await order(page)).toEqual(["beta", "alpha"]);
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});
