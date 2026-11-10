import { expect, test } from "@playwright/test";

// WP-177. The marker after a move, the refusal copy with its reason, and the recap fallback when the target cannot
// resume. Runs on Chromium and WebKit through the default projects.
test("the marker names the host and the time", async ({ page }) => {
  await page.goto("/tests/browser/teleport-notice.html");
  await expect(page.getByRole("status").filter({ hasText: "Moved to Studio box, 10 Nov 2026, 09:00" })).toBeVisible();
});

test("a running turn is refused with the reason and no recap", async ({ page }) => {
  await page.goto("/tests/browser/teleport-notice.html");
  const notice = page.locator("#turn-running");
  await expect(notice.getByRole("heading", { name: "Finish this turn, then move" })).toBeVisible();
  await expect(notice).toContainText("It can move once that turn finishes.");
  await expect(notice.getByRole("button")).toHaveCount(0);
});

test("a target that cannot resume explains why and offers the recap fallback", async ({ page }) => {
  await page.goto("/tests/browser/teleport-notice.html");
  const notice = page.locator("#cannot-resume");
  await expect(notice.getByRole("heading")).toContainText("the other machine cannot resume this chat");
  await expect(notice).toContainText("this host does not run claude");
  await notice.getByRole("button", { name: "Start a new chat with a recap" }).click();
  await expect(page.getByTestId("recap-state")).toHaveText("Recap requested");
});
