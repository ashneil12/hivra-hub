import { expect, test } from "@playwright/test";

// WP-177: start, approve, refusal and the marker of the chat-move panel, on Chromium and WebKit.
test("start shows the plan with the queued text and the redaction count; approve moves the chat", async ({ page }) => {
  await page.goto("/tests/browser/teleport-move.html");
  await page.getByTestId("teleport-start").click();
  const plan = page.getByTestId("teleport-plan");
  await expect(plan).toContainText("then tell the team");
  await expect(page.getByTestId("teleport-plan-redactions")).toContainText("Values redacted before the move: 1");
  await page.getByTestId("teleport-approve").click();
  await expect(page.getByTestId("teleport-done")).toContainText("Moved to Studio box");
});

test("a host that cannot resume refuses with the reason and offers the recap as a new chat", async ({ page }) => {
  await page.goto("/tests/browser/teleport-move.html?cannotResume=1");
  await page.getByTestId("teleport-start").click();
  await page.getByTestId("teleport-approve").click();
  const refusal = page.getByRole("status", { name: "Chat move" });
  await expect(refusal.getByRole("heading")).toContainText("the other machine cannot resume this chat");
  await refusal.getByRole("button", { name: "Start a new chat with a recap" }).click();
  await expect(page.getByTestId("saved-count")).toHaveText("1");
});

test("a chat with a turn in flight is refused in the plan, from the app's own state", async ({ page }) => {
  await page.goto("/tests/browser/teleport-move.html?busy=1");
  await page.getByTestId("teleport-start").click();
  await expect(page.getByRole("status", { name: "Chat move" }).getByRole("heading")).toContainText("Finish this turn, then move");
  await expect(page.getByTestId("teleport-approve")).toHaveCount(0);
});

test("after the move, the marker says where the chat is", async ({ page }) => {
  await page.goto("/tests/browser/teleport-move.html");
  await page.getByTestId("teleport-start").click();
  await page.getByTestId("teleport-approve").click();
  await expect(page.getByTestId("teleport-done")).toBeVisible();
});
