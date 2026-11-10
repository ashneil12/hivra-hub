import { expect, test } from "@playwright/test";

// WP-177. The marker after a move, the refusal copy with its reason, and the recap fallback when the target cannot
// resume. Runs on Chromium and WebKit through the default projects.
test("the marker names the host and the time", async ({ page }) => {
  await page.goto("/tests/browser/teleport-notice.html");
  await expect(page.locator("#on-host").getByRole("status")).toContainText("Moved to Studio box, 10 Nov 2026, 09:00");
  await expect(page.locator("#on-host")).toContainText("continues in a fresh session there, started from the saved messages");
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

// WP-177: the band at the top of a moved chat, and the refusal the composer shows when the person tries to send.
test("a moved chat shows the band with the host, the time, and the fresh-session statement", async ({ page }) => {
  await page.goto("/tests/browser/teleport-notice.html");
  const band = page.getByTestId("teleport-header-band");
  await expect(band).toContainText("Moved to Studio box");
  await expect(band).toContainText("continues in a fresh session there");
});

test("a moved chat refuses a send with the reason, and sends nothing", async ({ page }) => {
  await page.goto("/tests/browser/teleport-notice.html");
  await expect(page.getByTestId("teleport-send-refusal")).toContainText("Nothing was sent");
});
