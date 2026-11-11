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
const move = (page: Page, what: "workerAsks" | "workerStuck" | "workerFailed" | "leadAsks") =>
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

  // Live: a worker asks its Lead, another goes quiet (its Lead's), and one fails for credits (Ash's).
  await move(page, "workerAsks");
  await move(page, "workerStuck");
  await move(page, "workerFailed");
  const asking = frame.locator('[data-list="attention"] [data-item="w:d2"]');
  const failed = frame.locator('[data-list="attention"] [data-item="w:d5"]');
  const quiet = frame.locator('[data-list="working"] [data-worker="d3"]');
  await expect(asking).toBeVisible();
  await expect(asking.locator(".question")).toHaveText("Three save slots or five?");
  await expect(asking.locator(".pick")).toHaveText("Suggested: Three slots");
  await expect(asking.locator(".status")).toContainText("Asking");
  // r30c: a quiet stall stays under its Lead, grey "With <Lead>", with the plain reason. It is not Needs you.
  await expect(frame.locator('[data-list="attention"] [data-item="w:d3"]')).toHaveCount(0);
  await expect(quiet.locator(".status")).toContainText("With EXO lead");
  await expect(quiet.locator(".status")).not.toHaveClass(/\bred\b/);
  // PM-6 (Critiquito, 21 Oct: "still running npm test" is jargon): the page says the command in plain words.
  await expect(quiet.locator(".doing")).toContainText("No output for 12 min · still running the build");
  // A failed worker Ash must sort is red Needs you, with the plain reason. r30c's button on this page is "Open".
  await expect(failed.locator(".status")).toContainText("Needs you");
  await expect(failed.locator(".status")).toHaveClass(/\bred\b/);
  await expect(failed.locator(".pick")).toHaveText("Out of credits");
  await expect(failed.getByRole("button", { name: "Open" })).toBeVisible();
  await expect(frame.locator("[data-summary]")).toHaveText("2 need you · 2 working · 4 idle");
  // Asking first, then the one that needs Ash.
  await expect(frame.locator('[data-list="attention"] [data-item]')).toHaveText([/Pick the save slot layout/, /Ship the save fix/]);
  expect(await frame.locator("body").innerText()).not.toMatch(/\bstuck\b/i);
  await shot(page, "agents-2-stuck-and-asking-on-top");

  // A page can't act by itself: a tap its own code makes with no click from Ash (here: a timer, once the last gesture
  // has worn off) is refused, and nothing reaches the app. (Playwright's evaluate counts as a gesture, hence the wait.)
  const inner = page.frames().find((f) => f !== page.mainFrame())!;
  await inner.evaluate(() => {
    const w = window as unknown as { hub: { call(n: string, a: unknown): Promise<unknown> }; byItself?: string };
    setTimeout(() => void w.hub.call("agents.stop", { workerId: "d1" }).then(() => (w.byItself = "ran"), (e: Error) => (w.byItself = e.message)), 6000);
  });
  await page.waitForTimeout(6500);
  expect(await inner.evaluate(() => (window as unknown as { byItself?: string }).byItself)).toBe("Hubs act only when you tap something on them, so nothing was done.");
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

  // Stop the save worker from its row: it is still running, so the delegation tree's own Stop takes it. The one that
  // needs Ash already finished (out of credits); Stop there says so and does not pretend it stopped.
  const save = exo.locator(".worker", { hasText: "Fix the save bug" });
  await save.getByRole("button", { name: "Stop" }).click();
  await expect.poll(async () => (await proof(page)).stops).toEqual([{ kind: "stopRow", id: "d1" }]);
  await expect(save.locator(".status")).toContainText("Stopped");
  await failed.getByRole("button", { name: "Stop" }).click();
  await expect(failed.locator(".note")).toHaveText("That work already finished.");
  await expect(failed).toBeVisible();

  // A Lead asks Ash (Waiting on you): Take it answers with its pick through Waiting on you, and it moves on.
  await move(page, "leadAsks");
  const hivra = frame.locator('[data-list="attention"] [data-item="a:hivra-lead"]');
  await expect(hivra.locator(".question")).toHaveText("send it to the waitlist today or wait for the new headline?");
  await shot(page, "agents-4-lead-asks");
  await hivra.getByRole("button", { name: "Take it" }).click();
  // r97 (g): the pick reads as its option. "My pick: send it today" names "Send it to the waitlist today"
  // (chatQuestions.ts optionForPick; pageSources.test.ts: "the pick reads as its option").
  await expect.poll(async () => (await proof(page)).sent).toEqual([{ id: "s-hivra", text: "Go with your pick: Send it to the waitlist today\n\n(sent from the Agents page)" }]);
  await expect(hivra).toHaveCount(0);
  await expect(frame.locator('[data-list="working"] [data-item="a:hivra-lead"] .row .doing')).toHaveText("Shipping to the testers");

  // Open: the worker's chat under its Mono, through the tree's own Open.
  await exo.locator(".worker", { hasText: "Fix the save bug" }).getByRole("button", { name: "Open" }).click();
  await expect.poll(async () => (await proof(page)).opened).toEqual(["child:w-d1"]);
  await shot(page, "agents-5-after");
});

// A button is one line (Ash, 20 Oct: "Take it" wrapped onto two in the stuck and asking rows), whatever the page's width:
// wide, the columns hold every row's buttons; narrow, a row stacks (name and state, what it is doing, its buttons)
// instead of squeezing its columns until things overlap. Checked on the real page by measuring what it drew.
const PROBLEMS = () => {
  const out: string[] = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) out.push(`the page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
  for (const b of document.querySelectorAll("button")) {
    const text = document.createRange();
    text.selectNodeContents(b);
    if (text.getClientRects().length > 1) out.push(`"${b.textContent}" wraps onto ${text.getClientRects().length} lines`);
  }
  const apart = (a: DOMRect, b: DOMRect) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
  for (const row of document.querySelectorAll<HTMLElement>(".row, .worker")) {
    const box = row.getBoundingClientRect();
    const who = row.querySelector(".name")?.textContent ?? "a row";
    const cells = [...row.children].filter((c) => c.getBoundingClientRect().width > 0);
    const buttons = [...row.querySelectorAll("button")];
    for (const part of [...cells, ...buttons]) {
      const r = part.getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`in "${who}", ${part.className || part.textContent} sticks out of its row`);
    }
    for (const [i, a] of cells.entries())
      for (const b of cells.slice(i + 1))
        if (!apart(a.getBoundingClientRect(), b.getBoundingClientRect())) out.push(`in "${who}", ${a.className || "a part"} overlaps ${b.className || "another"}`);
    for (const button of buttons)
      for (const cell of cells.filter((c) => !c.contains(button)))
        if (!apart(button.getBoundingClientRect(), cell.getBoundingClientRect())) out.push(`in "${who}", "${button.textContent}" overlaps ${cell.className || "a part"}`);
  }
  return out;
};

test("every button stays on one line, and rows still fit, from a wide page to a narrow one", async ({ page }) => {
  await page.goto("/tests/browser/agents-page.html");
  await expect(page.locator("[data-pages-open] h1")).toHaveText("Agents");
  const frame = page.frameLocator("iframe[data-bespoke-page]");
  await move(page, "workerAsks");
  await move(page, "workerStuck");
  await move(page, "leadAsks");
  // The widest row: a worker asking its Lead (Take it, Answer, Open, Stop); a Lead asking Ash; a quiet one under its Lead.
  await expect(frame.locator('[data-list="attention"] [data-item="w:d2"]').getByRole("button", { name: "Take it" })).toBeVisible();
  await expect(frame.locator('[data-list="attention"] [data-item="a:hivra-lead"]')).toBeVisible();
  const inner = () => page.frames().find((f) => f !== page.mainFrame())!;
  // The page's own width is what its layout answers to (it sits in a column up to 768px wide with 32px at each side).
  // A fixed sleep races WebKit: the iframe's layout is not flushed yet, so the measure sees a wrap or an overlap that
  // is gone a frame later. Wait until two frames have passed and the measure is clean. A real wrap stays and fails.
  for (const width of [1100, 760, 700, 560, 420]) {
    await page.locator("#root").evaluate((root, w) => void (root.style.width = `${w}px`), width);
    await expect.soft
      .poll(
        async () => {
          const frame = inner();
          await frame.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
              }),
          );
          return frame.evaluate(PROBLEMS);
        },
        { timeout: 2_000, message: `at ${width}px` },
      )
      .toEqual([]);
    await shot(page, `agents-width-${width}`);
  }
});

test("Rebuild changes the page from Ash's words: the new version previews live, and Use this version keeps the page and its permissions", async ({ page }) => {
  await page.goto("/tests/browser/agents-page.html");
  await expect(page.locator("[data-pages-open] h1")).toHaveText("Agents");
  // No Mono runs here: the dev stub stands in for the one that changes the page.
  await page.evaluate(() => localStorage.setItem("monocode:pages-dev-stub", "1"));
  // Dropwave: Ask for a change sits behind the page's three-dot menu.
  await page.locator("[data-pages-menu-button]").click();
  await page.locator("[data-pages-rebuild]").click();
  await page.locator('[data-pages-rebuild-ask] input[aria-label="What should change"]').fill("Add a column for stuck time");
  await shot(page, "rebuild-1-ask");
  await page.locator("[data-pages-rebuild-ask] form button[type=submit]").click();
  const version = page.locator("[data-pages-new-version]");
  // The project's lead builds a page when one is seated on it; otherwise the first seated Mono does. Nothing is special-cased.
  await expect(version).toContainText("“Add a column for stuck time” · Chief of Staff built a new version");
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
