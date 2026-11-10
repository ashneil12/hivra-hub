import { expect, test } from "@playwright/test";

const ASK = "[data-ask]";

async function open(page: import("@playwright/test").Page) {
  await page.goto("/tests/browser/wp100-ask.html");
  await expect(page.locator(ASK)).toHaveCount(1);
  await expect(page.locator(ASK)).toContainText("Is this still true?");
}

/** The item's record as the screen holds it, so a test reads what the answer did to the data. */
async function item(page: import("@playwright/test").Page, text: string) {
  return page.evaluate((wanted) => {
    const doc = (window as unknown as { __doc: { items: Array<Record<string, unknown>> } }).__doc;
    return doc.items.find((row) => row.text === wanted) ?? null;
  }, text);
}

test("asks one question at a time, about the faintest fact", async ({ page }) => {
  await open(page);
  await expect(page.locator(ASK)).toContainText("Likes small commits");
  // The fresh fact is not asked about, and neither is the second fading one while one is on screen.
  await expect(page.locator(ASK)).not.toContainText("Reviews happen on Friday");
  await expect(page.locator(ASK)).not.toContainText("Prefers tabs over spaces");
  await expect(page.locator("body")).toContainText("Likes small commits");
});

test("still true tops the fact up and no other question appears in the same sitting", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Still true" }).click();
  await expect(page.locator(ASK)).toHaveCount(0);
  await expect(page.getByText("Likes small commits", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await item(page, "Likes small commits"))?.fade)
    .toBe(1);
  const row = await item(page, "Likes small commits");
  expect(row?.support).toBe(2);
  expect(row?.asked).toBe(3);
});

test("it changed replaces the wording and keeps the fact as the person's own", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "It changed" }).click();
  await expect(page.getByLabel("What is true now")).toBeVisible();
  await page.getByLabel("What is true now").fill("Likes tiny commits");
  await page.getByRole("button", { name: "Save the new wording" }).click();
  await expect(page.locator(ASK)).toHaveCount(0);
  await expect(page.getByText("Likes tiny commits", { exact: true })).toBeVisible();
  const row = await item(page, "Likes tiny commits");
  expect(row?.state).toBe("edited");
  expect(row?.support).toBe(2);
  // The old wording is gone from the screen, and the history is kept.
  await expect(page.getByText("Likes small commits", { exact: true })).toHaveCount(0);
  expect(typeof row?.createdAt).toBe("number");
});

test("blank new wording cannot be saved", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "It changed" }).click();
  await page.getByLabel("What is true now").fill("   ");
  await expect(page.getByRole("button", { name: "Save the new wording" })).toBeDisabled();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: "Still true" })).toBeVisible();
});

test("no longer true removes the fact", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "No longer true" }).click();
  await expect(page.locator(ASK)).toHaveCount(0);
  await expect(page.getByText("Likes small commits", { exact: true })).toHaveCount(0);
  expect(await item(page, "Likes small commits")).toBeNull();
});

test("not sure leaves the fact as it was and does not top it up", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Not sure" }).click();
  await expect(page.locator(ASK)).toHaveCount(0);
  await expect(page.getByText("Likes small commits", { exact: true })).toBeVisible();
  const row = await item(page, "Likes small commits");
  expect(row?.fade).toBe(0.05);
  expect(row?.support).toBe(1);
  expect(row?.asked).toBe(3);
  // No second question in this sitting.
  await expect(page.locator(ASK)).toHaveCount(0);
});
