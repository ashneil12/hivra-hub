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

test("there is no switch that promises an Always answer for programs that can run any code", async ({ page }) => {
  await page.goto("/tests/browser/wp92-secrets.html");
  await expect(page.getByRole("checkbox", { name: /always/i })).toHaveCount(0);
  await expect(page.getByText("Let me choose 'Always' for programs that can run any code")).toHaveCount(0);
  await expect(
    page.getByText("'Always' lets an agent use this key for anything, without asking you. Leave this off unless you are sure."),
  ).toHaveCount(0);
});

test("writing a key to a .env that other accounts can read says so", async ({ page }) => {
  await page.goto("/tests/browser/wp92-secrets.html?project");
  const stripe = page.locator("li", { hasText: "stripe-api-key" });
  await stripe.getByRole("button", { name: "Write to a worktree's .env" }).click();
  await stripe.getByRole("button", { name: "Write", exact: true }).click();
  await expect(stripe.getByText("This file can be read by other accounts on this Mac.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __fixture: { envWrites: string[] } }).__fixture.envWrites)).toEqual([
    "/work/proj",
  ]);
});

test("a row names where its key lives, and says which copy is used when a name is saved both ways", async ({ page }) => {
  await page.goto("/tests/browser/wp92-secrets.html");
  const everywhere = page.locator("li", { hasText: "SendGrid everywhere" });
  const project = page.locator("li", { hasText: "SendGrid project" });
  await expect(everywhere.getByText("Everywhere", { exact: true })).toBeVisible();
  await expect(project.getByText("Project: proj", { exact: true })).toBeVisible();
  await expect(project.getByText("This project's copy is used; there is also one for everywhere.")).toBeVisible();
  await expect(everywhere.getByText("Projects that have their own copy of this name use that one instead.")).toBeVisible();
  // A name saved one way only says nothing about copies.
  await expect(page.locator("li", { hasText: "Stripe" }).getByText(/copy/)).toHaveCount(0);
});

test("the request card works while mounted under StrictMode, as the app mounts it", async ({ page }) => {
  await page.goto("/tests/browser/wp92-secrets.html");
  const card = page
    .locator("section[aria-label='A key is needed']")
    .filter({ has: page.locator("#secret-label-req-1") });
  await expect(card).toBeVisible();
  // No "no longer open" line from a double mount, and the field is usable.
  await expect(page.getByText("That card is no longer open.")).toHaveCount(0);
  const field = page.locator("#secret-value-req-1");
  await field.fill(SAVED);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  // The list shows the saved key's last four only; the value is nowhere on the page.
  await expect(page.getByText(`ends ${SAVED.slice(-4)}`)).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(SAVED);
});

test("a dev copy's Secrets page says its list is the dev keychain's", async ({ page }) => {
  await page.goto("/tests/browser/wp92-secrets.html?dev");
  await expect(
    page.getByText("This is a dev copy, so this list holds the dev keychain's keys, not your daily app's."),
  ).toBeVisible();
});

test("the chat's key ask saves the value once and it is nowhere on the page afterwards", async ({ page }, testInfo) => {
  await page.goto("/tests/browser/wp92-secrets.html");
  await expect(page.getByText("This chat needs a key from you")).toBeVisible();
  await expect(page.getByText(/stripe live secret key/i).first()).toBeVisible();
  // Not a text box that would become a chat message.
  await expect(page.locator("section[aria-label='A key is needed'] textarea")).toHaveCount(0);

  const card = page
    .locator("section[aria-label='A key is needed']")
    .filter({ has: page.locator("#secret-key-ask-value") });
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
