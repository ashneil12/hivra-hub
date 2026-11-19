import { expect, test } from "@playwright/test";

test("the sidebar calls the person back to choose what comes in, then the chats come in behind them", async ({ page }) => {
  await page.goto("/tests/browser/chat-import-setup.html");
  const card = page.locator("[data-import-rail-card]");
  await expect(card).toContainText("Your chats are found");
  await expect(card).toContainText("13 chats. Choose what comes in");
  await card.locator("[data-import-rail-open]").click();
  const setup = page.locator('[data-import-setup][data-part="choose"]');
  await expect(setup.getByRole("heading", { name: "Choose what comes in" })).toBeVisible();
  await expect(setup.locator("[data-chat-import-group]")).toHaveCount(3);
  // Not now closes it and changes nothing; the card is still there to come back to.
  await setup.locator("[data-import-setup-later]").click();
  await expect(setup).toHaveCount(0);
  await expect(page.locator("[data-fixture-phase]")).toHaveText("ready");
  await card.locator("[data-import-rail-open]").click();
  await setup.locator("[data-chat-import-merge]").first().click();
  await setup.locator("[data-chat-import-go]").click();
  // The card closes at once: the person is back in the app while the chats come in.
  await expect(setup).toHaveCount(0);
  await expect(page.locator("[data-fixture-phase]")).toHaveText("done");
});

test("the suggested rules are a tick list: only ticked ones are saved", async ({ page }) => {
  await page.goto("/tests/browser/chat-import-setup.html?part=rules");
  await expect(page.locator("[data-import-rail-card]")).toContainText("3 suggested rules are ready");
  await page.locator("[data-import-rail-open]").click();
  const setup = page.locator('[data-import-setup][data-part="rules"]');
  await expect(setup.locator("[data-import-setup-rules-summary]")).toContainText("3 suggested rules from 13 of your chats");
  const rows = setup.locator("[data-import-setup-rule]");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute("aria-checked", "true");
  await expect(rows.first()).toContainText("Example: please split this, I like small commits");
  await rows.nth(1).click();
  await expect(setup.locator("[data-import-setup-accept]")).toHaveText("Save 2 rules");
  await setup.locator("[data-import-setup-accept]").click();
  await expect(setup).toHaveCount(0);
  await expect(page.locator("[data-fixture-saved]")).toHaveText("Saved: r1, r3");
  await expect(page.locator("[data-import-rail-card]")).toHaveCount(0);
});

test("a rule that can't be saved stays in the list and says so", async ({ page }) => {
  await page.goto("/tests/browser/chat-import-setup.html?part=rules&refuse");
  await page.locator("[data-import-rail-open]").click();
  const setup = page.locator('[data-import-setup][data-part="rules"]');
  await setup.locator("[data-import-setup-accept]").click();
  await expect(setup).toContainText("One rule couldn't be saved and is still here.");
  await expect(setup.locator("[data-import-setup-rule]")).toHaveCount(1);
});
