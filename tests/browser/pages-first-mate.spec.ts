import { expect, test, type Page } from "@playwright/test";

// G15: New page on Pages asks the chosen first mate in its own chat, and its page_build there comes back to the card as
// the preview to apply. A first mate that ends its turn without a page, or is busy, gets a plain line and Try again.
type Proof = { sent: { sessionId: string; text: string }[] };
const proof = (page: Page) => page.evaluate(() => (window as unknown as { proof: Proof }).proof);
const fixture = (page: Page, what: "answer" | "endTurn" | "busy", arg?: unknown) =>
  page.evaluate(([w, a]) => {
    (window as unknown as { fixture: Record<string, (x?: unknown) => unknown> }).fixture[w as string](a);
  }, [what, arg] as const);

async function ask(page: Page, text: string) {
  await page.goto("/tests/browser/pages-first-mate.html");
  await page.locator('[data-pages-new] input[aria-label="Describe the page"]').fill(text);
  await page.locator("[data-pages-new] form button[type=submit]").click();
}

test("New page goes to Ed's own chat and Ed's page_build there is the preview to apply", async ({ page }) => {
  await ask(page, "a page of every agent");
  await expect(page.locator('[data-pages-build-state="building"]')).toContainText("Ed is building your page in its chat");
  await expect(page.locator("[data-pages-open-chat]")).toHaveText("Open Ed's chat");
  await expect.poll(async () => (await proof(page)).sent.length).toBe(1);
  const sent = (await proof(page)).sent[0];
  expect(sent.sessionId).toBe("chat-ed");
  expect(sent.text).toContain("“a page of every agent”");
  expect(sent.text).toContain("page_build");

  await fixture(page, "answer");
  await expect(page.locator("[data-pages-preview] h1")).toHaveText("Every agent");
  await expect(page.locator("[data-pages-preview]")).toContainText("Ed built this preview");
  await page.locator("[data-pages-keep]").click();
  await expect(page.locator("[data-pages-open] h1")).toHaveText("Every agent");
});

test("Ed's turn ends without a page: the card says so with his words and Try again asks again", async ({ page }) => {
  await ask(page, "a page of every agent");
  await expect.poll(async () => (await proof(page)).sent.length).toBe(1);
  await fixture(page, "endTurn", "I can't see the agents from here.");
  const problem = page.locator('[data-pages-build-problem="no-page"]');
  await expect(problem).toContainText("No page yet");
  await expect(problem).toContainText("I can't see the agents from here.");
  await page.locator("[data-pages-try-again]").click();
  await expect.poll(async () => (await proof(page)).sent.length).toBe(2);
});

test("a busy first mate gets nothing sent and a Try again line", async ({ page }) => {
  await page.goto("/tests/browser/pages-first-mate.html");
  await fixture(page, "busy", true);
  await page.locator('[data-pages-new] input[aria-label="Describe the page"]').fill("a page of every agent");
  await page.locator("[data-pages-new] form button[type=submit]").click();
  await expect(page.locator('[data-pages-build-problem="busy"]')).toContainText("Ed is busy");
  await expect(page.locator("[data-pages-try-again]")).toBeVisible();
  expect((await proof(page)).sent).toEqual([]);
});
