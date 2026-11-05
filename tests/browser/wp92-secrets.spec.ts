// Hivra WP-92: the Secrets page and the chat's key ask, on Chromium and WebKit.
import { expect, test } from "@playwright/test";
import fs from "node:fs";

const SHOTS = "docs/hivra/work/shots";
const REVEALED = "sk_live_revealed_4821";
const SAVED = "sk_live_51NxAbCdEfGhIjKl";

test("the Secrets page lists a key with its last four, reveals on a tap, renames, rotates and deletes", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/browser/wp92-secrets.html");

  // The list: a saved key with its last four, and an imported one that needs its value first.
  await expect(page.getByText("Stripe", { exact: true })).toBeVisible();
  await expect(page.getByText("stripe-api-key", { exact: true })).toBeVisible();
  await expect(page.getByText("ends 4821")).toBeVisible();
  await expect(page.getByText("Needs its value")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add the value" })).toBeVisible();

  // Add a secret from the page.
  await page.getByRole("button", { name: "Add a secret" }).click();
  await page.locator("#secret-add-name").fill("github-token");
  await page.locator("#secret-add-label").fill("GitHub");
  await page.locator("#secret-add-value").fill("ghp_abcdef012345");
  await page
    .locator("section")
    .filter({ has: page.locator("#secret-add-name") })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(page.getByText("github-token", { exact: true })).toBeVisible();
  await expect(page.getByText("ends 2345")).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("ghp_abcdef012345");

  // Reveal is a tap: the value shows in its own field and is gone when the row closes.
  const stripe = page.locator("li", { hasText: "stripe-api-key" });
  await stripe.getByRole("button", { name: "Reveal" }).click();
  await expect(page.getByText("Show this key on screen? Anyone looking can see it.")).toBeVisible();
  await page.getByRole("button", { name: "Show it" }).click();
  await expect(stripe.getByLabel("The key")).toHaveValue(REVEALED);
  await stripe.getByRole("button", { name: "Close" }).click();
  await expect(stripe.getByLabel("The key")).toHaveCount(0);

  // Rename keeps the row and all its approvals.
  await stripe.getByRole("button", { name: "Rename" }).click();
  await stripe.getByLabel("Label").fill("Stripe live");
  await stripe.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Stripe live", { exact: true })).toBeVisible();
  await expect(page.getByText("stripe-api-key", { exact: true })).toBeVisible();

  // Rotate: the last four change; the value itself never shows.
  await stripe.getByRole("button", { name: "Rotate" }).click();
  await stripe.getByLabel("The new key").fill("sk_live_rotated_9999");
  await stripe.getByRole("button", { name: "Save" }).click();
  await expect(stripe.getByText("ends 9999")).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("sk_live_rotated_9999");

  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/wp92-secrets-${testInfo.project.name}.png` });

  // Delete asks first.
  const resend = page.locator("li", { hasText: "resend-key" });
  await resend.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(/Delete Resend\?/)).toBeVisible();
  await resend.getByRole("button", { name: "Delete it" }).click();
  await expect(page.getByText("resend-key", { exact: true })).toHaveCount(0);
});

test("the chat's key ask saves the value once and it is nowhere on the page afterwards", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp92-secrets.html");
  await expect(page.getByText("This chat needs a key from you")).toBeVisible();
  await expect(page.getByText(/stripe live secret key/i).first()).toBeVisible();
  // Not a text box that would become a chat message.
  await expect(page.locator("section[aria-label='A key is needed'] textarea")).toHaveCount(0);

  const card = page.locator("section[aria-label='A key is needed']");
  await card.locator("#secret-key-ask-value").fill(SAVED);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved in your Mac's keychain.")).toBeVisible();

  // The page's text, the DOM afterwards, and both storages never hold it.
  expect(await page.locator("body").innerText()).not.toContain(SAVED);
  const dom = await page.evaluate(() => document.documentElement.outerHTML);
  expect(dom).not.toContain(SAVED);
  const fields = await page.evaluate(() => [...document.querySelectorAll("input")].map((input) => input.value).join("\n"));
  expect(fields).not.toContain(SAVED);
  for (const storage of ["localStorage", "sessionStorage"] as const) {
    const dump = await page.evaluate((name) => JSON.stringify({ ...window[name] }), storage);
    expect(dump).not.toContain(SAVED);
  }

  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/wp92-key-ask-${testInfo.project.name}.png` });
});
