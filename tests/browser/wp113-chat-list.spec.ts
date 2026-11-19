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

test("a settled chat comes back when an approval is listed for it from elsewhere, and goes back once answered", async ({ page }) => {
  await page.goto(PAGE);
  await setting(page, true);

  await pick(page, "beta", "Settle");
  await expect(row(page, "beta")).toHaveCount(0);
  await expect(page.locator("[data-settled-shelf]")).toContainText("1");

  // The approval has no card in beta's own chat and no time: an approval is never hidden, so beta is back.
  await page.getByRole("button", { name: "Beta approval listed", exact: true }).click();
  await expect(row(page, "beta")).toBeVisible();
  await expect(page.locator("[data-settled-shelf]")).toHaveCount(0);

  // Answered: nothing about it is new any more, so it is back on the shelf.
  await page.getByRole("button", { name: "Beta listed approval answered", exact: true }).click();
  await expect(row(page, "beta")).toHaveCount(0);
  await expect(page.locator("[data-settled-shelf]")).toContainText("1");
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});

test("Settle is disabled, with the reason, while a listed approval waits on the chat", async ({ page }) => {
  await page.goto(PAGE);
  await setting(page, true);
  await page.getByRole("button", { name: "Beta approval listed", exact: true }).click();

  await row(page, "beta").click({ button: "right" });
  const settle = page.getByRole("menuitem", { name: /^Settle/ });
  await expect(settle).toBeDisabled();
  await expect(settle).toContainText("Answer its approval first");
  // Clicking it does nothing: the chat stays in the list and the notice never shows.
  await settle.click({ force: true });
  await expect(page.locator("[data-inbox-notice]")).toHaveCount(0);
  await expect(row(page, "beta")).toBeVisible();
  // Snooze is not held back.
  await expect(page.getByRole("menuitem", { name: "Snooze", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");

  // A chat with no approval waiting settles as usual, and beta's settle is open again once its approval is answered.
  await pick(page, "alpha", "Settle");
  await expect(row(page, "alpha")).toHaveCount(0);
  await page.getByRole("button", { name: "Beta listed approval answered", exact: true }).click();
  await row(page, "beta").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Settle", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});


test("a chat with only its own open question can still be settled, and it stays settled", async ({ page }) => {
  await page.goto(PAGE);
  await setting(page, true);
  await page.getByRole("button", { name: "Alpha asks a question", exact: true }).click();

  // The question is in the approval ids too (the app lists a chat that needs input), but it is the chat's own.
  await row(page, "alpha").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Settle", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await pick(page, "alpha", "Settle");
  await expect(page.locator("[data-inbox-notice]")).toContainText("Settled");
  await expect(row(page, "alpha")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(row(page, "alpha")).toHaveCount(0);
  await expect(page.locator("[data-settled-shelf]")).toContainText("1");
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});

test("a chat with its own open question and a listed approval cannot be settled until the approval is answered", async ({ page }) => {
  await page.goto(PAGE);
  await setting(page, true);

  // Beta has a question of its own, and a worker's approval is listed on it too.
  await page.getByRole("button", { name: "Beta asks a question", exact: true }).click();
  await page.getByRole("button", { name: "Beta approval listed", exact: true }).click();

  await row(page, "beta").click({ button: "right" });
  const settle = page.getByRole("menuitem", { name: /^Settle/ });
  await expect(settle).toBeDisabled();
  await expect(settle).toContainText("Answer its approval first");
  await settle.click({ force: true });
  await expect(page.locator("[data-inbox-notice]")).toHaveCount(0);
  await expect(row(page, "beta")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Snooze", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");

  // The approval is answered; the question is still open, and that alone does not hold the settle back.
  await page.getByRole("button", { name: "Beta listed approval answered", exact: true }).click();
  await row(page, "beta").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Settle", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});

test("a chat settled with its own open question comes back for a listed approval, and goes back once answered", async ({ page }) => {
  await page.goto(PAGE);
  await setting(page, true);

  // Settled with a question open, which the person did knowing: it stays on the shelf.
  await page.getByRole("button", { name: "Beta asks a question", exact: true }).click();
  await pick(page, "beta", "Settle");
  await expect(row(page, "beta")).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(row(page, "beta")).toHaveCount(0);
  await expect(page.locator("[data-settled-shelf]")).toContainText("1");

  // A worker's approval is listed on it: an approval is never hidden, so the chat is back and Settle is off.
  await page.getByRole("button", { name: "Beta approval listed", exact: true }).click();
  await expect(row(page, "beta")).toBeVisible();
  await expect(page.locator("[data-settled-shelf]")).toHaveCount(0);
  await row(page, "beta").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Settle/ })).toBeDisabled();
  await page.keyboard.press("Escape");

  // Answered: the question was already there when it was settled, so it goes back to the shelf.
  await page.getByRole("button", { name: "Beta listed approval answered", exact: true }).click();
  await expect(row(page, "beta")).toHaveCount(0);
  await expect(page.locator("[data-settled-shelf]")).toContainText("1");
  await expect(page.locator("body")).not.toContainText(/[—–]/);
});
