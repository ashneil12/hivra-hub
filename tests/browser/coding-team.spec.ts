import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// The coding team is the main place Ash talks (Ash, 20 Oct: "mainly the coding team is the main place i want to talk
// to"; "I don't talk to workers. I only talk to orchestrators."). The real app in a browser (hub-dev.html reading the
// stub through its real transport), with chats seeded in EXO's folder as session_list_by_project returns them and
// delegation rows as delegations.rs does: the Lead pinned on top and opened by default, its sub-chats folded until one
// is stuck, Ash's own chats at the top level with theirs folded under them, one click into a chat or a sub-chat, and
// "Open in coding team" landing on the Lead. Each step is photographed.
//
//   STUCK_PROOF_PORT=1523 PROOF_SPEC=coding-team.spec.ts npx playwright test -c tests/browser/stuck-workers.config.ts

const SHOTS = process.env.CODING_TEAM_PROOF_DIR ?? "test-results/coding-team";
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());
test.use({ viewport: { width: 1440, height: 900 } });

const FOLDER = "/Users/example/Projects/vg-game";
const TEAM_CHAT = "6f1c2a9e-save";
const OTHER_CHAT = "9b3d-dodge";

function chats(now: number) {
  const chat = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, cwd: FOLDER, harness: "claude", model: "claude:sonnet-5", runtimeMode: "supervised", title,
    createdAt: now - 3_600_000, updatedAt: now - 60_000, ...patch,
  });
  return [
    chat(TEAM_CHAT, "Fix the save bug", {
      blocks: [
        { id: "b1", role: "user", text: "the save bug on mission two, can u sort it" },
        { id: "b2", role: "assistant", text: "Got it: the save bug on mission two. One worker is checking mission two saves; I'll tell you what it finds." },
      ],
    }),
    // Started by Ash's chat with /operator (no row): nested by its id alone.
    chat(`app-${TEAM_CHAT}-r9`, "Save bug: write the regression test", { updatedAt: now - 30_000 }),
    // Its delegated worker (delegate_task names it `app-<chat>-<request>`).
    chat(`app-${TEAM_CHAT}-t-5`, "Check mission two saves", {
      runtimeMode: "full-access",
      blocks: [{ id: "w1", role: "user", text: "[MonoCode brief from EXO coding team]\n\nCheck that mission two saves." }],
    }),
    chat(OTHER_CHAT, "Air dodge timing", { updatedAt: now - 7_200_000 }),
  ];
}

function rows(lead: string, now: number) {
  const row = (id: string, owner: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, ownerSession: owner, ownerMono: owner === lead ? "vg-game-lead" : null, batchId: "turn-1", parentId: null, rootId: id,
    childSession: `app-${owner}-${id}`, requestId: `r-${id}`, generation: 1, project: "vg-game", title, brief: title, goal: null,
    askIds: [], state: "running", errorClass: null, error: null, retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: now - 30 * 60_000 + Number(id.slice(2)) * 1000,
    updatedAt: now - 60_000, settledAt: null, log: [], version: 1, mirroredVersion: 1, mirrorError: null, ...patch,
  });
  return [
    row("t-1", lead, "Wire the dodge input"),
    row("t-2", lead, "Pick the dodge timing", {
      state: "question",
      pendingQuestion: "How long should the air dodge last? [0.25 s (Recommended) | 0.4 s]",
      log: [{ at: now - 40_000, by: "worker", event: "asked" }],
    }),
    row("t-3", lead, "Run the movement tests", { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 9 * 60_000 }),
    row("t-4", lead, "Read the dodge rules", { state: "completed", settledAt: now - 20 * 60_000, delivery: "acknowledged" }),
    // Ash's own coding-team chat delegated too: one still working.
    row("t-5", TEAM_CHAT, "Check mission two saves"),
  ];
}

const leadRow = (page: Page) => page.locator("[data-coding-team-lead]");
const card = (page: Page, id: string) => page.locator(`[data-session-card="${id}"]`);
const monoViewShown = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("[data-mono-view]")].some((e) => e.getBoundingClientRect().width > 0));

test("the coding team opens on its Lead, nests every chat's sub-chats, and opens any of them in one click", async ({ page }) => {
  const now = Date.now();
  await page.addInitScript(
    ({ list, team }) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("monocode:dev-sessions", JSON.stringify(list));
      // Ash's chat took a turn in EXO's folder: it is a coding-team chat (codingTeam.ts).
      localStorage.setItem("monocode:coding-team-chats", JSON.stringify({ [team]: "vg-game" }));
    },
    { list: chats(now), team: TEAM_CHAT },
  );
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });

  // Picking EXO lands in its coding team, on its Lead: the item reads Coding team, the Lead's row is pinned on top
  // and current, and its chat is open beside the list.
  await page.getByRole("button", { name: /^EXO/ }).first().click();
  await expect(leadRow(page)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("monocode:hub-nav"))).toContain('"item":"coding-team"');
  await expect(leadRow(page)).toContainText("EXO lead");
  await expect(leadRow(page).locator('[aria-current="true"]')).toBeVisible();
  await expect.poll(() => monoViewShown(page)).toBe(true);
  const lead = await page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>).find(
        (m) => m.id === "vg-game-lead",
      )?.sessionId ?? "",
  );
  expect(lead).not.toBe("");
  // The list is the Lead first, then Ash's own chats; the chat his chat started is not one of them.
  await expect(card(page, TEAM_CHAT)).toBeVisible();
  await expect(card(page, OTHER_CHAT)).toBeVisible();
  await expect(card(page, `app-${TEAM_CHAT}-r9`)).toHaveCount(0);

  await page.evaluate((list) => {
    localStorage.setItem("monocode:dev-delegations", JSON.stringify(list));
    (window as unknown as { __devDelegationsChanged(): void }).__devDelegationsChanged();
  }, rows(lead, now));

  // A stuck sub-chat opens the Lead's sub-chats by itself, newest first, each with its mark; the Lead's row carries
  // the most urgent mark. Ash's chat's sub-chats stay folded under their count: nothing of theirs is stuck.
  const leadSubs = page.locator(`[data-sub-chats="${lead}"] [data-sub-chat]`);
  await expect(leadSubs).toHaveCount(4);
  await expect(leadSubs.nth(0)).toHaveAttribute("data-state", "completed");
  await expect(page.locator(`[data-sub-chat="app-${lead}-t-3"]`)).toHaveAttribute("data-state", "stalled");
  await expect(page.locator(`[data-sub-chat="app-${lead}-t-3"]`)).toHaveAttribute("aria-label", /No output for 9 min/);
  await expect(page.locator(`[data-sub-chat="app-${lead}-t-2"]`)).toHaveAttribute("data-state", "question");
  await expect(leadRow(page).locator("[data-mono-stuck-kind]")).toHaveAttribute("data-mono-stuck-kind", "stalled");
  const teamToggle = page.locator(`[data-sub-chats-toggle="${TEAM_CHAT}"]`);
  await expect(teamToggle).toHaveText("2 sub-chats");
  await expect(teamToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`[data-sub-chats="${TEAM_CHAT}"]`)).toHaveCount(0);
  // The Lead's own chat shows what is out and a card per stuck worker, as before.
  await expect(page.locator("[data-delegation-working]:visible").first()).toContainText("1 working: Wire the dodge input");
  await shot(page, "1-lead-default-stuck-open");

  // Folded, the Lead's sub-chats say what is stuck; Ash's chat's unfold on a click.
  await page.locator(`[data-sub-chats-toggle="${lead}"]`).click();
  await expect(leadSubs).toHaveCount(0);
  await expect(page.locator(`[data-sub-chats-toggle="${lead}"]`)).toHaveText("4 sub-chats · 2 stuck");
  await shot(page, "2-folded");
  await teamToggle.click();
  const teamSubs = page.locator(`[data-sub-chats="${TEAM_CHAT}"] [data-sub-chat]`);
  await expect(teamSubs).toHaveCount(2);
  await expect(teamSubs.nth(0)).toHaveText("Check mission two saves");
  await expect(teamSubs.nth(1)).toHaveText("Save bug: write the regression test");
  await shot(page, "3-unfolded");

  // One click on Ash's chat: the Lead steps aside, the list stays, and his chat (an orchestrator too) reads what is out.
  await card(page, TEAM_CHAT).click();
  await expect.poll(() => monoViewShown(page)).toBe(false);
  await expect(leadRow(page)).toBeVisible();
  await expect(leadRow(page).locator('[aria-current="true"]')).toHaveCount(0);
  await expect(card(page, TEAM_CHAT).locator('[aria-current="true"]')).toBeVisible();
  await expect(page.locator("[data-delegation-working]:visible").first()).toHaveText("1 working: Check mission two saves");
  await shot(page, "4-coding-team-chat");

  // One click on a sub-chat opens it: a worker runs on its own and points back at the chat that started it.
  await page.locator(`[data-sub-chat="app-${TEAM_CHAT}-t-5"]`).click();
  await expect(page.locator("[data-delegated-chat]:visible").first()).toContainText("Open EXO coding team", { timeout: 10_000 });
  await shot(page, "5-sub-chat-open");

  // Back to EXO: the coding team now opens on the chat Ash was in, and the Lead is one click away.
  await page.getByRole("button", { name: /^Hivra/ }).first().click();
  await page.getByRole("button", { name: /^EXO/ }).first().click();
  await expect(leadRow(page)).toBeVisible();
  await expect.poll(() => monoViewShown(page)).toBe(false);
  await leadRow(page).locator("[data-session-card]").click();
  await expect.poll(() => monoViewShown(page)).toBe(true);

  // Being built: "Open in coding team" lands on the Lead in its coding team, never the room.
  await page.getByRole("button", { name: "Being built" }).click();
  await expect(page.locator("[data-hub-worker]").first()).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-hub-worker]").first().click();
  await page.locator("[data-hub-open-coding]").click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("monocode:hub-nav"))).toContain('"item":"coding-team"');
  await expect.poll(() => monoViewShown(page)).toBe(true);
  await expect(leadRow(page).locator('[aria-current="true"]')).toBeVisible();
  await expect(page.locator('[data-hub-item="coding-team"]')).toHaveAttribute("title", "EXO lead and your chats in EXO's code");
  await expect(page.locator('[data-hub-item="leadership-team"]')).toHaveAttribute("title", "The leadership team's group chat");
  await shot(page, "6-open-in-coding-team");
});
