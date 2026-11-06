import { expect, test, type Page } from "@playwright/test";
import { openLocalHub } from "./localHub";

// WP-94: a paste of 32 KiB or more (measured in bytes) into the Mono chat's composer becomes a text file named by
// its first words instead of flooding the prompt, and Cmd/Ctrl+Shift+V keeps it inline, including on a keyboard
// layout whose V key types another character. The paste is dispatched with a DataTransfer because a browser test
// cannot fill the real clipboard; a dispatched paste does not insert text itself, so "kept inline" is read from the
// event going unprevented and no chip appearing.

test.use({ viewport: { width: 1440, height: 900 } });

const rail = (page: Page) => page.locator("[data-mono-rail]").first();
const leadRow = (page: Page) => rail(page).locator('button[aria-label^="EXO lead"]').first();
const composer = (page: Page) => page.getByLabel("Message EXO lead");

/** A text paste with `text` as its plain text: true when the composer let the paste through untouched. */
async function pasteText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    return document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    ) ?? false;
  }, text);
}

const LARGE = ["build log for the mac app", "a line of the log".repeat(2_000), "the end"].join("\n");

test("a big paste becomes a text file, and Cmd/Ctrl+Shift+V keeps it inline", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
  });
  await openLocalHub(page, "&fakeClaude");
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });
  await leadRow(page).click();
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });

  // 1. An ordinary paste becomes a chip named after its first words, and the prompt stays empty.
  expect(new TextEncoder().encode(LARGE).length).toBeGreaterThanOrEqual(32 * 1024);
  await composer(page).click();
  expect(await pasteText(page, LARGE)).toBe(false);
  await expect(
    page.getByRole("button", { name: "Remove build log for the mac app.txt" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-composer-notice]").first()).toHaveText(
    "That paste was large, so it became the file build log for the mac app.txt. Hold Shift while pasting to keep it inline.",
  );
  await expect(composer(page)).toHaveValue("");

  // 2. The same paste with Cmd/Ctrl+Shift+V stays inline: no further chip, and the composer leaves it alone.
  await composer(page).click();
  await composer(page).press("Control+Shift+V");
  expect(await pasteText(page, LARGE)).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: /^Remove .*\.txt$/ })).toHaveCount(1);
});

test("the inline shortcut still works on a layout whose V key types another character", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
  });
  await openLocalHub(page, "&fakeClaude");
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });
  await leadRow(page).click();
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });

  await composer(page).click();
  // A Cyrillic layout reports "м" for the physical V key; the keydown event's code is still KeyV.
  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "м",
        code: "KeyV",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(await pasteText(page, LARGE.replace("build log", "second log"))).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.getByRole("button", { name: /^Remove .*\.txt$/ })).toHaveCount(0);
});
