import { expect, test } from "@playwright/test";

test("the health card shows what memory has done, in plain words", async ({ page }) => {
  await page.goto("/tests/browser/wp100-health.html");
  const card = page.getByLabel("Memory health");
  await expect(card).toBeVisible();
  await expect(card.locator("[data-health-last-run]")).toHaveText("Memory was last looked at 2 hours ago.");
  await expect(card.locator("[data-health-turns]")).toHaveText("12 chats looked at. 4 facts kept.");
  await expect(card.locator("[data-health-deferred]")).toHaveText(
    "2 turns were left until later, because the writing side was busy.",
  );
  await expect(card.locator("[data-health-dropped='secret']")).toHaveText("3 facts were not kept: with a secret in them.");
  await expect(card.locator("[data-health-dropped='late']")).toHaveText(
    "1 fact was not kept: from a chat that had already moved on.",
  );
  await expect(card.locator("[data-health-dropped='ungrounded']")).toHaveCount(0);
  await expect(card.locator("[data-health-fading]")).toHaveText("2 facts are fading from not being used.");
  await expect(card.locator("[data-health-asks]")).toHaveText(
    "2 facts are waiting for you to say whether they are still true.",
  );
  // The card is above the facts, not one of them.
  const facts = page.locator("[data-id]");
  await expect(facts).toHaveCount(2);
  expect((await card.boundingBox())!.y).toBeLessThan((await facts.first().boundingBox())!.y);
});
