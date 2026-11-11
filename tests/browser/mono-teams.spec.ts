import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { openLocalHub } from "./localHub";

// Teams, not sub-chats (Ash, 20 Oct: "monos shouldn't really have sub chats, if its stuff to fix it should either do it
// itself or pick it up with the coding team. IF they do need to do work ... something like coding team should be created
// for that mono"). The real app in a browser (hub-dev.html reading the local store through its real transport), with
// delegation rows as delegations.rs returns them and chats as session_list_by_project does:
// - the Monos rail lists people: nothing extra for a Mono with nothing out, on hover too; no sub-chats under any Mono, a
//   Lead's included; one line says what each has out ("2 working · 1 needs you", red only for what Ash must act on), and Open team on the row;
// - Chief of Staff briefed EXO's coding team: its chat shows ONE live line for it, which opens the coding team on the
//   Lead, where the brief's workers nest under the Lead;
// - Alfred did work of its own: its own team, a workspace like a coding team, with Alfred's chat pinned on top and its
//   workers under it, opened from its row or the Team button in its chat.
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

test.use({ viewport: { width: 1440, height: 900 } });

const EXO = "/Users/example/Projects/vg-game";
/** Where this browser page's app data is (browserTauriMock.ts DEV_DATA), and so Alfred's team folder. */
const TEAM = "/Users/ash/Library/Application Support/com.ash.monocode-hub.dev.browser/mono-teams/alfred";
/** The people this proof used to get from the built-in team. The rail only lists a Mono on the open project. */
const TEAM_ROSTER = [
  { id: "alfred", name: "Alfred", mascot: "robot", color: "hsl(210 8% 58%)", engine: "claude", role: "Does its own work", projects: [EXO] },
  { id: "chief-of-staff", name: "Chief of Staff", mascot: "crab", color: "hsl(142 55% 50%)", engine: "claude", role: "Briefs the coding team", projects: [EXO] },
  { id: "frank", name: "frank", mascot: "robot", color: "hsl(210 8% 58%)", engine: "claude", role: "Nothing out", projects: [EXO] },
];

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
    // Chief of Staff briefed EXO's coding team; the Lead split it over three workers, one of them quiet (its Lead's).
    row("b-1", chats.cos, "chief-of-staff", "Fix the save bug", { follow: "lead", childSession: chats.lead, requestId: `app-${chats.cos}-b1` }),
    leadWorker("t-1", "Find the save path"),
    leadWorker("t-2", "Write the save test"),
    leadWorker("t-3", "Run the save tests", { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 9 * 60_000 }),
    // Alfred's own work: research and a draft, in its own team; one failed because the provider is out of credits.
    row("a-1", chats.alfred, "alfred", "Research launch posts", { project: null }),
    row("a-2", chats.alfred, "alfred", "Draft the launch thread", { project: null }),
    row("a-3", chats.alfred, "alfred", "Collect competitor pricing", {
      project: null, state: "failed", errorClass: "billing", error: "402", settledAt: now - 2 * 60_000,
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

test("Monos show people, not work: briefs live in coding teams, a Mono's own work in its own team", async ({ page }) => {
  const now = Date.now();
  await page.addInitScript(
    ({ team, roster }) => {
      localStorage.setItem("monocode:dev-roster-seed", JSON.stringify(roster));
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      // Alfred made its team the first time it handed out work of its own (monoTeams.ts).
      localStorage.setItem("monocode:mono-teams", JSON.stringify({ alfred: { monoId: "alfred", folder: team, createdAt: Date.now() - 3_600_000 } }));
    },
    { team: TEAM, roster: TEAM_ROSTER },
  );
  await openLocalHub(page);
  await expect(rail(page)).toBeVisible({ timeout: 60_000 });
  await expect(railRow(page, "EXO lead")).toBeVisible({ timeout: 30_000 });

  // 0. Nothing out yet: the rail is the shipped one (Ash's screenshot, 20 Oct: "basically this is good"), with nothing
  // extra under or on any Mono, on hover too, though Alfred already has a team and the EXO lead its coding team.
  await page.mouse.move(900, 500);
  await expect(rail(page).locator("[data-mono-work], [data-mono-open-team], [data-mono-children], [data-mono-child]")).toHaveCount(0);
  await shot(page, "0-rail-at-rest");
  await railRow(page, "EXO lead").hover();
  await expect(rail(page).locator('button[aria-label="EXO lead options"]')).toBeVisible();
  await expect(rail(page).locator("[data-mono-open-team]")).toHaveCount(0);
  await page.mouse.move(900, 500);

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
  // The project's Today is the sidebar's Needs you item now (G1: no central area; hubNav.ts showProjectToday).
  await page.getByRole("button", { name: /^Needs you/ }).first().click();
  await page.mouse.move(900, 500);

  // 1. The rail: no sub-chats under anyone, a Lead included; one line each says what it has out.
  // r30: a quiet stall is its Lead's, so it is not on the line. A billing failure is red "1 needs you".
  await expect(rail(page).locator("[data-mono-children], [data-mono-child], [data-mono-children-toggle]")).toHaveCount(0);
  const work = (id: string) => rail(page).locator(`[data-mono-work="${id}"]`);
  await expect(work("vg-game-lead").locator("[data-mono-work-split]")).toHaveText("2 working");
  await expect(work("vg-game-lead")).toHaveAttribute("data-mono-work-kind", "working");
  await expect(work("alfred").locator("[data-mono-work-split]")).toHaveText("2 working · 1 needs you");
  await expect(work("alfred")).toHaveAttribute("data-mono-work-kind", "needs-you");
  await expect(work("chief-of-staff").locator("[data-mono-work-split]")).toHaveText("1 working");
  await expect(work("frank")).toHaveCount(0);
  await expect(rail(page).locator('[data-mono-stuck-kind="failed"]')).toHaveCount(1);
  // r51c: the chip, the panel and the rail say the same count. The panel's one row is red Needs you, with the plain
  // reason and Open <Lead>'s chat. No surface prints "stuck".
  const chip = work("alfred").locator("[data-stuck-trigger]");
  await expect(chip).toHaveText("1 needs you");
  await expect(chip).toHaveClass(/text-red-400/);
  await chip.click();
  const panel = page.locator("[data-stuck-panel]");
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-stuck-worker]")).toHaveCount(1);
  await expect(panel).toContainText("1 needs you");
  await expect(panel.locator("[data-stuck-line]")).toHaveText("Out of credits");
  await expect(panel.getByRole("button", { name: "Open Alfred's chat" })).toBeVisible();
  expect(await rail(page).innerText()).not.toMatch(/\bstuck\b/i);
  expect(await panel.innerText()).not.toMatch(/\bstuck\b/i);
  await chip.click();
  await expect(panel).toBeHidden();
  await shot(page, "1-rail-people-not-work");
  // Open team on hover: a Lead's coding team, Alfred's own; Chief of Staff has none (it only briefs).
  await railRow(page, "Alfred").hover();
  await expect(rail(page).locator('[data-mono-open-team="alfred"]')).toBeVisible();
  await expect(rail(page).locator('[data-mono-open-team="alfred"]')).toHaveAttribute("aria-label", "Open Alfred's team");
  await expect(rail(page).locator('[data-mono-open-team="chief-of-staff"]')).toHaveCount(0);
  await expect(rail(page).locator('[data-mono-open-team="vg-game-lead"]')).toHaveAttribute("aria-label", "Open EXO coding team");
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/1b-rail-open-team-on-hover.png` });
  await page.mouse.move(900, 500);

  // 2. Chief of Staff's chat: one live line for its brief, never the Lead's workers.
  await railRow(page, "Chief of Staff").click();
  await expect.poll(() => monoViewShown(page)).toBe(true);
  const brief = page.locator("[data-briefed-team='b-1']:visible");
  // r30b: the brief says whose the stall is, never "stuck". "Briefed EXO coding team: <task> · 2 working · 1 with EXO lead".
  await expect(brief).toHaveText("Briefed EXO coding team: Fix the save bug · 2 working · 1 with EXO lead");
  await expect(brief).toHaveAttribute("data-briefed-kind", "with-lead");
  await expect(page.locator("[data-stuck-worker]:visible")).toHaveCount(0);
  await shot(page, "2-cos-chat-briefing-line");

  // 3. One click: EXO's coding team on its Lead, the brief's workers nested under the Lead, the stuck one open.
  await brief.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("monocode:hub-nav"))).toContain('"item":"coding-team"');
  await expect(page.locator("[data-coding-team-lead]")).toHaveAttribute("data-team-kind", "coding");
  await expect(page.locator("[data-coding-team-lead]")).toContainText("EXO lead");
  await expect(page.locator(`[data-sub-chats="${chats.lead}"] [data-sub-chat]`)).toHaveCount(3);
  // r88 (Ash, B13): the same worker chats also nest under the Lead on the rail, so the stalled check stays on this team list.
  await expect(page.locator(`[data-sub-chats="${chats.lead}"] [data-sub-chat="app-${chats.lead}-t-3"]`)).toHaveAttribute("data-state", "stalled");
  await shot(page, "3-coding-team-from-the-brief");

  // 4. Alfred's own team, from its row: Alfred pinned on top ("Owner"), its workers under it, the failed one open.
  await railRow(page, "Alfred").hover();
  await rail(page).locator('[data-mono-open-team="alfred"]').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("monocode:hub-nav"))).toContain('"item":"team:alfred"');
  const owner = page.locator('[data-coding-team-lead][data-team-kind="mono"]');
  await expect(owner).toBeVisible({ timeout: 15_000 });
  await expect(owner).toContainText("Alfred");
  await expect(owner).toContainText("Owner");
  await expect(owner.locator('[aria-current="true"]')).toBeVisible();
  await expect.poll(() => monoViewShown(page)).toBe(true);
  const subs = page.locator(`[data-sub-chats="${chats.alfred}"] [data-sub-chat]`);
  await expect(subs).toHaveCount(3);
  await expect(subs.and(page.locator(`[data-sub-chat="app-${chats.alfred}-a-3"]`))).toHaveAttribute("data-state", "failed");
  // Chief of Staff's brief and the Lead's workers are EXO's, never in Alfred's team. The rail still nests EXO's own (r88).
  await expect(subs.and(page.locator(`[data-sub-chat="app-${chats.lead}-t-1"]`))).toHaveCount(0);
  // The Team button in Alfred's chat is pressed; the strip highlights no project, the rail marks Alfred.
  await expect(page.locator("[data-mono-view-team]:visible")).toHaveAttribute("aria-pressed", "true");
  await expect(railRow(page, "Alfred")).toHaveAttribute("aria-current", "true");
  await page.mouse.move(900, 500);
  await shot(page, "4-alfreds-team");

  // 5. One click on a worker opens it in the team; Alfred's row stays marked, the list stays.
  await subs.and(page.locator(`[data-sub-chat="app-${chats.alfred}-a-1"]`)).click();
  await expect.poll(() => monoViewShown(page)).toBe(false);
  await expect(owner).toBeVisible();
  await expect(page.locator("[data-delegated-chat]:visible").first()).toContainText("Open Alfred", { timeout: 10_000 });
  await expect(railRow(page, "Alfred")).toHaveAttribute("aria-current", "true");
  await shot(page, "5-alfreds-worker-in-its-team");

  // 6. From Alfred's chat on its own, the Team button opens the team; pressed again, the chat stands alone.
  // The project's Today is the sidebar's Needs you item now (G1: no central area; hubNav.ts showProjectToday).
  await page.getByRole("button", { name: /^Needs you/ }).first().click();
  await railRow(page, "Alfred").click();
  await expect.poll(() => monoViewShown(page)).toBe(true);
  const teamButton = page.locator("[data-mono-view-team]:visible");
  await expect(teamButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-coding-team-lead][data-team-kind="mono"]')).toHaveCount(0);
  await shot(page, "6-alfred-chat-team-button");
  await teamButton.click();
  await expect(page.locator('[data-coding-team-lead][data-team-kind="mono"]')).toBeVisible({ timeout: 15_000 });
  await expect(teamButton).toHaveAttribute("aria-pressed", "true");
  await teamButton.click();
  await expect(page.locator('[data-coding-team-lead][data-team-kind="mono"]')).toHaveCount(0);
  await expect.poll(() => monoViewShown(page)).toBe(true);
});
