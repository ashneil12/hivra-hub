import { expect, test } from "@playwright/test";

const pageUrl = "/tests/browser/wp115-cant.html";

test("says when the agent cannot redirect, and still lets Claude steer", async ({
  page,
}) => {
  await page.goto(pageUrl);
  const grok = page.locator("#grok");
  const claude = page.locator("#claude");
  const sentence = "Grok Build can't redirect a running turn. Stop it, then send.";

  await grok.scrollIntoViewIfNeeded();
  await expect(grok.getByRole("note")).toHaveText(sentence);
  await expect(grok.getByRole("button", { name: "Steer" })).toHaveCount(0);
  // The box already has a message. Send stays Send and the message waits.
  await expect(grok.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(grok.getByRole("button", { name: "Stop" })).toHaveCount(0);

  const empty = page.locator("#grok-empty");
  await empty.scrollIntoViewIfNeeded();
  await expect(empty.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(empty.getByRole("button", { name: "Send" })).toHaveCount(0);

  await claude.scrollIntoViewIfNeeded();
  await expect(claude.getByRole("button", { name: "Steer" })).toBeVisible();
  await expect(claude.getByRole("note")).toHaveCount(0);
  await expect(claude.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(
    claude.getByText(
      "Compacted this idle chat so the next message does not rebuild the whole prompt cache.",
    ),
  ).toBeVisible();
});
