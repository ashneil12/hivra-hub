import { expect, test, type Page } from "@playwright/test";

// The real Sidebar's Sessions tab: rows are [data-session-card], the shelves and the undo notice are the ones the
// Sidebar mounts, and settle and snooze are picked from a chat's context menu, as a person does.
const PAGE = "/tests/browser/wp113-chat-list.html";

async function order(page: Page): Promise<string[]> {
  return page.locator("[data-session-card]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-session-card") ?? ""),
  );
}

function row(page: Page, id: string) {
  return page.locator(`[data-session-card='${id}']`);
}

async function pick(page: Page, id: string, ...path: string[]) {
  await row(page, id).click({ button: "right" });
  for (const name of path) await page.getByRole("menuitem", { name, exact: true }).click();
}

async function openShelf(page: Page, marker: "settled" | "snoozed") {
  const shelf = page.locator(`[data-${marker}-shelf]`);
  await shelf.getByRole("button", { name: new RegExp(marker === "settled" ? "Settled" : "Snoozed") }).click();
  return shelf;
}

async function setting(page: Page, on: boolean) {
  const toggle = page.getByRole("switch", { name: "Settle and snooze" });
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
}

test("setting off leaves the list as it is, including a settled mark", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "monocode.chatListInboxState",
      JSON.stringify({ rev: 1, chats: { alpha: { touch: 1, settledAt: 1 } } }),
    );
  });
  await page.goto(PAGE);
  await expect(row(page, "alpha")).toBeVisible();
  await expect(row(page, "beta")).toBeVisible();
  expect(await order(page)).toEqual(["beta", "alpha", "gamma"]);
  await row(page, "beta").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Session actions" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Settle", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Snooze", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-settled-shelf]")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});

test("settle, undo, snooze and unsnooze, and re-sort only while the setting is on", async ({ page }) => {
  await page.goto(PAGE);
  expect(await order(page)).toEqual(["beta", "alpha", "gamma"]);
  await page.getByRole("button", { name: "Needs you", exact: true }).click();
  expect(await order(page)).toEqual(["beta", "alpha", "gamma"]);

  await setting(page, true);
  await expect.poll(() => order(page)).toEqual(["alpha", "beta", "gamma"]);

  await pick(page, "beta", "Settle");
  await expect(row(page, "beta")).toHaveCount(0);
  const settled = await openShelf(page, "settled");
  await expect(settled).toContainText("Beta");
  await page.locator("[data-inbox-notice]").getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row(page, "beta")).toBeVisible();
  await expect(page.locator("[data-settled-shelf]")).toHaveCount(0);

  await pick(page, "beta", "Snooze", "In 1 hour");
  await expect(row(page, "beta")).toHaveCount(0);
  const snoozed = await openShelf(page, "snoozed");
  await expect(snoozed).toContainText("Beta");
  await snoozed.getByRole("button", { name: "Unsnooze", exact: true }).click();
  await expect(row(page, "beta")).toBeVisible();

  await setting(page, false);
  await expect.poll(() => order(page)).toEqual(["beta", "alpha", "gamma"]);
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});

test("a settled chat comes back when it needs you or gets a new message", async ({ page }) => {
  await page.goto(PAGE);
  await setting(page, true);

  // Settled and calm: it stays on the shelf.
  await pick(page, "beta", "Settle");
  await expect(row(page, "beta")).toHaveCount(0);
  await expect(page.locator("[data-settled-shelf]")).toContainText("1");

  // It asks for an approval: it is back in the list, and the shelf is gone.
  await page.getByRole("button", { name: "Beta asks for approval", exact: true }).click();
  await expect(row(page, "beta")).toBeVisible();
  await expect(page.locator("[data-settled-shelf]")).toHaveCount(0);

  // The approval is answered and nothing new was said: it goes back to the shelf.
  await page.getByRole("button", { name: "Beta approval decided", exact: true }).click();
  await expect(row(page, "beta")).toHaveCount(0);
  await expect(page.locator("[data-settled-shelf]")).toContainText("1");

  // A chat the person writes in after settling it comes back and stays back.
  await pick(page, "gamma", "Settle");
  await expect(row(page, "gamma")).toHaveCount(0);
  await page.getByRole("button", { name: "Gamma gets a message", exact: true }).click();
  await expect(row(page, "gamma")).toBeVisible();

  // Settling it again hides it, since that is newer than the message.
  await pick(page, "gamma", "Settle");
  await expect(row(page, "gamma")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});

test("a chat settled while it already needs you stays settled, and comes back for a newer ask", async ({ page }) => {
  await page.goto(PAGE);
  await setting(page, true);

  // Alpha is asking for an approval when the person settles it, knowing that.
  await page.getByRole("button", { name: "Needs you", exact: true }).click();
  await expect(row(page, "alpha")).toBeVisible();
  await pick(page, "alpha", "Settle");
  await expect(page.locator("[data-inbox-notice]")).toContainText("Settled");
  await expect(row(page, "alpha")).toHaveCount(0);
  await expect(page.locator("[data-settled-shelf]")).toContainText("1");

  // Nothing about it is new, so the row does not come back a moment later either.
  await page.waitForTimeout(500);
  await expect(row(page, "alpha")).toHaveCount(0);
  await expect(page.locator("[data-settled-shelf]")).toContainText("1");

  // It asks again after the settle: that is a new need, so it is back.
  await page.getByRole("button", { name: "Alpha asks again", exact: true }).click();
  await expect(row(page, "alpha")).toBeVisible();
  await expect(page.locator("[data-settled-shelf]")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});
