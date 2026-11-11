import { expect, test } from "@playwright/test";

// A page that navigates its own frame away keeps the same contentWindow (HTML spec), so the app can't tell by the window.
// What it has to see: the frame is cut off at once and replaced by a fresh frame with a fresh bridge, and whatever is in
// the old frame gets no answer to a call, though Ash approved this page's read.
test.use({ viewport: { width: 900, height: 700 } });

test("a page that navigates away loses its bridge and the frame is rebuilt", async ({ page }) => {
  await page.goto("/tests/browser/page-navigates.html");
  const frame = page.frameLocator("iframe[data-bespoke-page]");
  await expect(frame.locator("#ok")).toHaveText("bridge works");
  const first = await page.locator("iframe[data-bespoke-page]").elementHandle();
  const inner = page.frames().find((f) => f !== page.mainFrame())!;

  // The page sets location. (A sandboxed frame has no way to reach another monoartifact: document outside the app; about:blank
  // is the same navigation as far as the bridge can tell: a new document in the same window.)
  await inner.evaluate(() => {
    (window as unknown as { replies: unknown[] }).replies = [];
    window.location.href = "about:blank";
  });
  await expect.poll(() => first!.evaluate((el) => !el.isConnected), { timeout: 5000 }).toBe(true);

  // The fresh frame has its own bridge and works again.
  await expect(frame.locator("#ok")).toHaveText("bridge works");
  const next = page.frames().filter((f) => f !== page.mainFrame());
  expect(next).toHaveLength(1);
});

test("a document that navigated away and then posts a call gets no reply", async ({ page }) => {
  await page.goto("/tests/browser/page-navigates.html");
  const frame = page.frameLocator("iframe[data-bespoke-page]");
  await expect(frame.locator("#ok")).toHaveText("bridge works");
  const inner = page.frames().find((f) => f !== page.mainFrame())!;
  await inner.evaluate(() => {
    window.location.href = "about:blank";
  });
  await expect.poll(() => inner.url()).toBe("about:blank");
  // Whatever is in that old frame now (if it is still there) speaks to the bridge as the page did.
  const answered = await inner
    .evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          window.addEventListener("message", (e) => e.data?.type === "hub:reply" && resolve(true));
          parent.postMessage({ type: "hub:call", id: "late", call: "agents.read", args: {} }, "*");
          setTimeout(() => resolve(false), 2500);
        }),
    )
    .catch(() => false); // the frame was already replaced: nothing there to answer to
  expect(answered).toBe(false);
});
