import { expect, test, type Page } from "@playwright/test";

// The ready-made Agents page (agents-page.tsx): the real Pages screen, the real bridge and the app's real stores, with
// only the app's own hands faked. The page has to follow the agents live (nothing reloads), and its taps have to reach
// the same hands Ash's own taps use: answering a stuck worker's question in its own chat, taking a Lead's pick, Stop.
type Proof = {
  responds: { id: string; requestId: number; reply: { kind: string; answers?: Record<string, string[]>; custom?: Record<string, string> } }[];
  sent: { id: string; text: string }[];
  opened: string[];
  stops: { kind: string; id: string }[];
};
const proof = (page: Page) => page.evaluate(() => (window as unknown as { proof: Proof }).proof);
const move = (page: Page, what: "workerAsks" | "workerStuck" | "leadAsks") =>
  page.evaluate((w) => (window as unknown as { fixture: Record<string, () => void> }).fixture[w](), what);

const SHOTS = process.env.AGENTS_PAGE_PROOF_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

test.use({ viewport: { width: 1100, height: 900 } });

test("the Agents page follows the agents live, and answers, takes a pick and stops through the app's own hands", async ({ page }) => {
  await page.goto("/tests/browser/agents-page.html");
  await expect(page.locator("[data-pages-open] h1")).toHaveText("Agents");
  const frame = page.frameLocator("iframe[data-bespoke-page]");

  // Every agent and what it is doing; the Lead's handed-out work under it.
  await expect(frame.locator("[data-summary]")).toHaveText("2 working · 4 idle");
  const exo = frame.locator('[data-list="working"] [data-item="a:vg-game-lead"]');
  await expect(exo.locator(".row .doing")).toHaveText("Reading the save system");
  await expect(exo.locator(".worker", { hasText: "Fix the save bug" }).locator(".doing")).toHaveText("Running the save tests");
  await expect(exo.locator(".worker")).toHaveCount(3);
  await expect(frame.locator('[data-section="attention"]')).toBeHidden();
  await shot(page, "agents-1-working");

  // Live: a worker asks its Lead, another gets stuck. Both rise to Needs you without a reload.
  await move(page, "workerAsks");
  await move(page, "workerStuck");
  const asking = frame.locator('[data-list="attention"] [data-item="w:d2"]');
  const stuck = frame.locator('[data-list="attention"] [data-item="w:d3"]');
  await expect(asking).toBeVisible();
  await expect(asking.locator(".question")).toHaveText("Three save slots or five?");
  await expect(asking.locator(".pick")).toHaveText("Suggested: Three slots");
  await expect(asking.locator(".status")).toContainText("Asking");
  await expect(stuck.locator(".status")).toContainText("Stuck");
  await expect(stuck.locator(".pick")).toContainText("Waiting for a usage limit to reset at");
  await expect(frame.locator("[data-summary]")).toHaveText("2 need you · 2 working · 4 idle");
  // Asking first, then stuck.
  await expect(frame.locator('[data-list="attention"] [data-item]')).toHaveText([/Pick the save slot layout/, /Build 0.15 for the playtest/]);
  await shot(page, "agents-2-stuck-and-asking-on-top");

  // A page can't act by itself: a tap its own code makes with no click from Ash (here: a timer, once the last gesture
  // has worn off) is refused, and nothing reaches the app. (Playwright's evaluate counts as a gesture, hence the wait.)
  const inner = page.frames().find((f) => f !== page.mainFrame())!;
  await inner.evaluate(() => {
    const w = window as unknown as { hub: { call(n: string, a: unknown): Promise<unknown> }; byItself?: string };
    setTimeout(() => void w.hub.call("agents.stop", { workerId: "d1" }).then(() => (w.byItself = "ran"), (e: Error) => (w.byItself = e.message)), 6000);
  });
  await page.waitForTimeout(6500);
  expect(await inner.evaluate(() => (window as unknown as { byItself?: string }).byItself)).toBe("Pages act only when you tap something on them, so nothing was done.");
  expect((await proof(page)).stops).toEqual([]);

  // Answer the stuck worker's question in Ash's words: it goes into the worker's own chat as his answer, signed.
  await asking.getByRole("button", { name: "Answer" }).click();
  const box = asking.locator(".answer input");
  await expect(box).toBeFocused();
  await box.fill("Three, and label them by date");
  await shot(page, "agents-3-answering");
  await asking.getByRole("button", { name: "Send" }).click();
  await expect.poll(async () => (await proof(page)).responds.length).toBe(1);
  const answered = (await proof(page)).responds[0];
  expect(answered).toMatchObject({ id: "w-d2", requestId: 7 });
  expect(answered.reply.custom?.layout).toBe("Three, and label them by date\n\n(sent from the Agents page)");
  // The worker is back at work, live: it leaves Needs you and shows under its Lead again.
  await expect(asking).toHaveCount(0);
  await expect(exo.locator(".worker", { hasText: "Pick the save slot layout" }).locator(".status")).toContainText("Working");
  await expect(page.locator("[data-page-activity]")).toContainText("Answered “Pick the save slot layout”: “Three, and label them by date” · from the Agents page · just now");

  // Stop the stuck one: the delegation tree's own Stop for that work.
  await stuck.getByRole("button", { name: "Stop" }).click();
  await expect.poll(async () => (await proof(page)).stops).toEqual([{ kind: "stopRow", id: "d3" }]);
  await expect(stuck).toHaveCount(0);
  await expect(exo.locator(".worker", { hasText: "Build 0.15 for the playtest" }).locator(".status")).toContainText("Stopped");

  // A Lead asks Ash (Waiting on you): Take it answers with its pick through Waiting on you, and it moves on.
  await move(page, "leadAsks");
  const hivra = frame.locator('[data-list="attention"] [data-item="a:hivra-lead"]');
  await expect(hivra.locator(".question")).toHaveText("send it to the waitlist today or wait for the new headline?");
  await shot(page, "agents-4-lead-asks");
  await hivra.getByRole("button", { name: "Take it" }).click();
  await expect.poll(async () => (await proof(page)).sent).toEqual([{ id: "s-hivra", text: "Go with your pick: send it today\n\n(sent from the Agents page)" }]);
  await expect(hivra).toHaveCount(0);
  await expect(frame.locator('[data-list="working"] [data-item="a:hivra-lead"] .row .doing')).toHaveText("Shipping to the testers");

  // Open: the worker's chat under its Mono, through the tree's own Open.
  await exo.locator(".worker", { hasText: "Fix the save bug" }).getByRole("button", { name: "Open" }).click();
  await expect.poll(async () => (await proof(page)).opened).toEqual(["child:w-d1"]);
  await shot(page, "agents-5-after");
});

test("Rebuild changes the page from Ash's words: the new version previews live, and Use this version keeps the page and its permissions", async ({ page }) => {
  await page.goto("/tests/browser/agents-page.html");
  await expect(page.locator("[data-pages-open] h1")).toHaveText("Agents");
  // No Mono runs here: the dev stub stands in for the one that changes the page.
  await page.evaluate(() => localStorage.setItem("monocode:pages-dev-stub", "1"));
  await page.locator("[data-pages-rebuild]").click();
  await page.locator('[data-pages-rebuild-ask] input[aria-label="What should change"]').fill("Add a column for stuck time");
  await shot(page, "rebuild-1-ask");
  await page.locator("[data-pages-rebuild-ask] form button[type=submit]").click();
  const version = page.locator("[data-pages-new-version]");
  await expect(version).toContainText("“Add a column for stuck time” · Projects Manager built a new version");
  await expect(version.locator("[data-pages-new-version-keeps]")).toHaveText("It keeps what you allowed it (6 things).");
  // The new version runs in its preview on the live data it asked to read.
  const preview = page.frameLocator("[data-pages-new-version] iframe[data-bespoke-page]");
  await expect(preview.locator("[data-summary]")).toHaveText("2 working · 4 idle");
  await expect(preview.locator("[data-rebuilt]")).toHaveText("Example: changed for “Add a column for stuck time”");
  await shot(page, "rebuild-2-new-version");
  await page.locator("[data-pages-use-version]").click();
  await expect(version).toHaveCount(0);
  const live = page.frameLocator("iframe[data-bespoke-page]");
  await expect(live.locator("[data-rebuilt]")).toBeVisible();
  await expect(page.locator("[data-pages-allowed]")).toHaveText("Allowed: 6 things");
  await shot(page, "rebuild-3-used");
});
