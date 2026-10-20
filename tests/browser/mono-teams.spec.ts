import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Where a Mono's work goes (Ash, 20 Oct): a project's work "should either do it itself or pick it up with the coding
// team", and "the mono sub chat setup is good too the one i saw, so team can be optional". The real app in a browser
// (hub-dev.html reading the stub through its real transport), with delegation rows as delegations.rs returns them and
// chats as session_list_by_project does:
// - the Monos rail nests every Mono's sub-chats under it, as shipped: folded under a count, open when one is stuck;
// - Chief of Staff briefed EXO's coding team: its chat shows ONE live line for it, which opens the coding team on the
//   Lead, where the brief's workers nest under the Lead;
// - Alfred did work of its own: its sub-chats nest under it in the rail until Ash gives it its own team from its menu;
//   then that team opens (Alfred's chat pinned on top, its workers under it), the rail keeps one line and Open team for
//   it, and "Use sub-chats instead" puts them back under it.
// Each step is photographed.
//
//   STUCK_PROOF_PORT=1523 PROOF_SPEC=mono-teams.spec.ts npx playwright test -c tests/browser/stuck-workers.config.ts

const SHOTS = process.env.MONO_TEAMS_PROOF_DIR ?? "test-results/mono-teams";
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

const EXO = "/Users/example/Projects/vg-game";
/** Where this browser page's app data is (browserTauriMock.ts DEV_DATA), and so Alfred's own folder (its team's, once on). */
const TEAM = "/Users/ash/Library/Application Support/com.ash.monocode-hub.dev.browser/mono-teams/alfred";

const rail = (page: Page) => page.locator("[data-mono-rail]").first();
const railRow = (page: Page, name: string) => rail(page).locator(`button[aria-label^="${name}"]`).first();
const sessionIdOf = (page: Page, monoId: string) =>
  page.evaluate(
    (id) =>
      (JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>).find(
        (m) => m.id === id,
      )?.sessionId ?? "",
    monoId,
  );
const monoViewShown = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("[data-mono-view]")].some((e) => e.getBoundingClientRect().width > 0));

/** Open a Mono from the rail and give back its chat's id. */
async function chatOf(page: Page, name: string, monoId: string): Promise<string> {
  await railRow(page, name).click();
  await expect.poll(() => sessionIdOf(page, monoId), { timeout: 15_000 }).not.toBe("");
  return sessionIdOf(page, monoId);
}

function rows(chats: { cos: string; lead: string; alfred: string }, now: number) {
  const row = (id: string, owner: string, ownerMono: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, ownerSession: owner, ownerMono, batchId: "turn-1", parentId: null, rootId: id, childSession: `app-${owner}-${id}`,
    requestId: `r-${id}`, generation: 1, project: "vg-game", title, brief: title, goal: null, askIds: [], state: "running",
    errorClass: null, error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null, delivery: "pending",
    deliveryMessage: null, createdAt: now - 30 * 60_000 + Number(id.replace(/\D/g, "")) * 1000, updatedAt: now - 60_000,
    settledAt: null, log: [], version: 1, mirroredVersion: 1, mirrorError: null, ...patch,
  });
  const leadWorker = (id: string, title: string, patch: Record<string, unknown> = {}) =>
    row(id, chats.lead, "vg-game-lead", title, { parentId: "b-1", rootId: "b-1", ...patch });
  return [
    // Chief of Staff briefed EXO's coding team; the Lead split it over three workers, one of them stuck.
    row("b-1", chats.cos, "chief-of-staff", "Fix the save bug", { follow: "lead", childSession: chats.lead, requestId: `app-${chats.cos}-b1` }),
    leadWorker("t-1", "Find the save path"),
    leadWorker("t-2", "Write the save test"),
    leadWorker("t-3", "Run the save tests", { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 9 * 60_000 }),
    // Alfred's own work: research and a draft, in its own folder; one failed on a usage limit.
    row("a-1", chats.alfred, "alfred", "Research launch posts", { project: null }),
    row("a-2", chats.alfred, "alfred", "Draft the launch thread", { project: null }),
    row("a-3", chats.alfred, "alfred", "Collect competitor pricing", {
      project: null, state: "failed", errorClass: "usage_limit", error: "Usage limit reached", settledAt: now - 2 * 60_000,
    }),
  ];
}

function sessions(chats: { alfred: string; lead: string }, now: number) {
  const chat = (id: string, cwd: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, cwd, harness: "claude", model: "claude:sonnet-5", runtimeMode: "full-access", title, sidebarHidden: true,
    createdAt: now - 1_800_000, updatedAt: now - 60_000, ...patch,
  });
  return [
    chat(`app-${chats.alfred}-a-1`, TEAM, "Research launch posts", {
      blocks: [{ id: "w1", role: "user", text: "[MonoCode brief from Alfred]\n\nResearch how launch posts did for tools like ours." }],
    }),
    chat(`app-${chats.alfred}-a-2`, TEAM, "Draft the launch thread"),
    chat(`app-${chats.alfred}-a-3`, TEAM, "Collect competitor pricing"),
    chat(`app-${chats.lead}-t-1`, EXO, "Find the save path"),
    chat(`app-${chats.lead}-t-2`, EXO, "Write the save test"),
    chat(`app-${chats.lead}-t-3`, EXO, "Run the save tests"),
  ];
}

test("Monos keep their sub-chats; a brief lives in its coding team; a Mono's own team is Ash's switch", async ({ page }) => {
  const now = Date.now();
  await page.addInitScript(
    ({ team }) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      // Alfred's own folder, made the first time it handed out work of its own (monoTeams.ts); its team is off.
      localStorage.setItem("monocode:mono-teams", JSON.stringify({ alfred: { monoId: "alfred", folder: team, createdAt: Date.now() - 3_600_000, on: false } }));
    },
    { team: TEAM },
  );
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}`);
  await expect(rail(page)).toBeVisible({ timeout: 60_000 });
  await expect(railRow(page, "EXO lead")).toBeVisible({ timeout: 30_000 });

  // Their chats, so the rows have owners.
  const chats = {
    alfred: await chatOf(page, "Alfred", "alfred"),
    cos: await chatOf(page, "Chief of Staff", "chief-of-staff"),
    lead: await chatOf(page, "EXO lead", "vg-game-lead"),
  };
  await page.evaluate(
    ({ list, chatsList }) => {
      localStorage.setItem("monocode:dev-sessions", JSON.stringify(chatsList));
      localStorage.setItem("monocode:dev-delegations", JSON.stringify(list));
      (window as unknown as { __devDelegationsChanged(): void }).__devDelegationsChanged();
    },
    { list: rows(chats, now), chatsList: sessions(chats, now) },
  );
  await page.getByRole("button", { name: "Today" }).first().click();
  await page.mouse.move(900, 500);

  // 1. The rail, as shipped: each Mono's sub-chats under it, opened by themselves where one is stuck, folded elsewhere.
  const toggle = (id: string) => rail(page).locator(`[data-mono-children-toggle="${id}"]`);
  const nested = (id: string) => rail(page).locator(`[data-mono-children="${id}"] [data-mono-child]`);
  await expect(toggle("vg-game-lead")).toHaveAttribute("aria-expanded", "true");
  await expect(nested("vg-game-lead")).toHaveCount(3);
  await expect(rail(page).locator(`[data-mono-child="app-${chats.lead}-t-3"]`)).toHaveAttribute("data-state", "stalled");
  await expect(toggle("alfred")).toHaveAttribute("aria-expanded", "true");
  await expect(nested("alfred")).toHaveCount(3);
  await expect(rail(page).locator(`[data-mono-child="app-${chats.alfred}-a-3"]`)).toHaveAttribute("data-state", "failed");
  // Chief of Staff's brief is its one sub-chat (the Lead's chat), folded; the Lead's workers never nest under it.
  await expect(toggle("chief-of-staff")).toHaveText("1 sub-chat");
  await expect(toggle("chief-of-staff")).toHaveAttribute("aria-expanded", "false");
  // No team for anyone yet: no Open team, no one-line summary.
  await expect(rail(page).locator("[data-mono-open-team], [data-mono-work]")).toHaveCount(0);
  await shot(page, "1-rail-sub-chats");

  // 2. Chief of Staff's chat: one live line for its brief, never the Lead's workers.
  await railRow(page, "Chief of Staff").click();
  await expect.poll(() => monoViewShown(page)).toBe(true);
  const brief = page.locator("[data-briefed-team='b-1']:visible");
  await expect(brief).toHaveText("Briefed EXO coding team: Fix the save bug · 2 working · 1 stuck");
  await expect(brief).toHaveAttribute("data-briefed-kind", "stuck");
  await expect(page.locator("[data-stuck-worker]:visible")).toHaveCount(0);
  await shot(page, "2-cos-chat-briefing-line");

  // 3. One click: EXO's coding team on its Lead, the brief's workers nested under the Lead, the stuck one open.
  await brief.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("monocode:hub-nav"))).toContain('"item":"coding-team"');
  await expect(page.locator("[data-coding-team-lead]")).toHaveAttribute("data-team-kind", "coding");
  await expect(page.locator("[data-coding-team-lead]")).toContainText("EXO lead");
  await expect(page.locator(`[data-sub-chats="${chats.lead}"] [data-sub-chat]`)).toHaveCount(3);
  await expect(page.locator(`[data-sub-chat="app-${chats.lead}-t-3"]`)).toHaveAttribute("data-state", "stalled");
  await shot(page, "3-coding-team-from-the-brief");

  // 4. The switch: Alfred's menu gives it its own team (a Lead's menu offers none).
  await page.getByRole("button", { name: "Today" }).first().click();
  await railRow(page, "EXO lead").click({ button: "right" });
  await expect(page.locator("[data-mono-menu-give-team]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await railRow(page, "Alfred").click({ button: "right" });
  const give = page.locator("[data-mono-menu-give-team]");
  await expect(give).toHaveText("Give Alfred its own team");
  await expect(page.locator("[data-mono-menu-open-team], [data-mono-menu-sub-chats]")).toHaveCount(0);
  await shot(page, "4-menu-give-alfred-its-own-team");

  // 5. On: the team opens at once, Alfred pinned on top ("Owner"), its workers under it, the failed one open; the rail
  // lists none of Alfred's sub-chats now, one line in their place.
  await give.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("monocode:hub-nav"))).toContain('"item":"team:alfred"');
  const owner = page.locator('[data-coding-team-lead][data-team-kind="mono"]');
  await expect(owner).toBeVisible({ timeout: 15_000 });
  await expect(owner).toContainText("Alfred");
  await expect(owner).toContainText("Owner");
  await expect(owner.locator('[aria-current="true"]')).toBeVisible();
  await expect.poll(() => monoViewShown(page)).toBe(true);
  const subs = page.locator(`[data-sub-chats="${chats.alfred}"] [data-sub-chat]`);
  await expect(subs).toHaveCount(3);
  await expect(page.locator(`[data-sub-chat="app-${chats.alfred}-a-3"]`)).toHaveAttribute("data-state", "failed");
  // Chief of Staff's brief and the Lead's workers are EXO's, never in Alfred's team.
  await expect(page.locator(`[data-sub-chat="app-${chats.lead}-t-1"]`)).toHaveCount(0);
  await expect(page.locator("[data-mono-view-team]:visible")).toHaveAttribute("aria-pressed", "true");
  await expect(railRow(page, "Alfred")).toHaveAttribute("aria-current", "true");
  await expect(toggle("alfred")).toHaveCount(0);
  const work = rail(page).locator('[data-mono-work="alfred"]');
  await expect(work.locator("[data-mono-work-split]")).toHaveText("2 working · 1 stuck");
  await expect(work).toHaveAttribute("data-mono-work-kind", "failed");
  // Everyone else keeps their sub-chats.
  await expect(nested("vg-game-lead")).toHaveCount(3);
  await page.mouse.move(900, 500);
  await shot(page, "5-alfreds-team-on");

  // 6. One click on a worker opens it in the team; Alfred's row stays marked, the list stays.
  await page.locator(`[data-sub-chat="app-${chats.alfred}-a-1"]`).click();
  await expect.poll(() => monoViewShown(page)).toBe(false);
  await expect(owner).toBeVisible();
  await expect(page.locator("[data-delegated-chat]:visible").first()).toContainText("Open Alfred", { timeout: 10_000 });
  await expect(railRow(page, "Alfred")).toHaveAttribute("aria-current", "true");
  await shot(page, "6-alfreds-worker-in-its-team");

  // 7. From Today, the rail's Open team (on hover) and its line open the team; Team in Alfred's chat toggles it.
  await page.getByRole("button", { name: "Today" }).first().click();
  await railRow(page, "Alfred").hover();
  const openTeam = rail(page).locator('[data-mono-open-team="alfred"]');
  await expect(openTeam).toBeVisible();
  await expect(openTeam).toHaveAttribute("aria-label", "Open Alfred's team");
  await expect(rail(page).locator('[data-mono-open-team="vg-game-lead"], [data-mono-open-team="chief-of-staff"]')).toHaveCount(0);
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/7-rail-open-team-on-hover.png` });
  await openTeam.click();
  await expect(owner).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Today" }).first().click();
  await railRow(page, "Alfred").click();
  await expect.poll(() => monoViewShown(page)).toBe(true);
  const teamButton = page.locator("[data-mono-view-team]:visible");
  await expect(teamButton).toHaveAttribute("aria-pressed", "false");
  await teamButton.click();
  await expect(owner).toBeVisible({ timeout: 15_000 });
  await expect(teamButton).toHaveAttribute("aria-pressed", "true");

  // 8. Off again from the menu: Alfred's sub-chats are back under it in the rail, Ash lands on its chat, no Team button.
  await railRow(page, "Alfred").click({ button: "right" });
  await expect(page.locator("[data-mono-menu-open-team]")).toHaveText("Open Alfred's team");
  const back = page.locator("[data-mono-menu-sub-chats]");
  await expect(back).toHaveText("Use sub-chats instead");
  await back.click();
  await expect(owner).toHaveCount(0);
  await expect.poll(() => monoViewShown(page)).toBe(true);
  await expect(page.locator("[data-mono-view-team]")).toHaveCount(0);
  await expect(nested("alfred")).toHaveCount(3);
  await expect(rail(page).locator("[data-mono-open-team], [data-mono-work]")).toHaveCount(0);
  await page.mouse.move(900, 500);
  await shot(page, "8-back-to-sub-chats");
});
