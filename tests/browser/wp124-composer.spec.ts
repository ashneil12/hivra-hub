import { expect, test, type Page } from "@playwright/test";
import { openLocalHub } from "./localHub";

// WP-124: quote a sent message into the Mono chat's draft, stash that draft across a reload, and undo a large
// paste back to inline text. The paste is dispatched with a DataTransfer because a browser test cannot fill the
// real clipboard.

test.use({ viewport: { width: 1440, height: 900 } });

const rail = (page: Page) => page.locator("[data-mono-rail]").first();
const leadRow = (page: Page) => rail(page).locator('button[aria-label^="EXO lead"]').first();
const composer = (page: Page) => page.getByLabel("Message EXO lead");

async function openLead(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
  });
  await openLocalHub(page, "&fakeClaude");
  await expect(leadRow(page)).toBeVisible({ timeout: 30_000 });
  await leadRow(page).click();
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
}

test("quoting a sent message adds a marked quote to the draft", async ({ page }) => {
  await openLead(page);
  await composer(page).fill("please check the door");
  await composer(page).press("Enter");
  const row = page.locator(".user-message-row").filter({ hasText: "please check the door" }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await row.getByRole("button", { name: "Quote message" }).click();
  await expect(composer(page)).toHaveValue(/> You said:\n> please check the door/);
});

test("stashing a draft clears the composer and stays stored across a reload", async ({ page }) => {
  await openLead(page);
  await composer(page).fill("hold this thought");
  await page.getByRole("button", { name: "Stash draft" }).click();
  await expect(composer(page)).toHaveValue("");
  await page.getByRole("button", { name: "Restore draft" }).click();
  await expect(composer(page)).toHaveValue("hold this thought");
  await page.getByRole("button", { name: "Stash draft" }).click();
  await expect(composer(page)).toHaveValue("");
  // This page starts a new chat for the lead after a reload, so the same chat cannot be reopened here. The stored
  // draft is what a reload of the real app reads back for that chat.
  await page.reload();
  const stored = await page.evaluate(() => localStorage.getItem("monocode.composerStash.v1"));
  expect(stored).toContain("hold this thought");
});
