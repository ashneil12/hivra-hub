import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openLocalHub, type SeedProject } from "./localHub";

// WP-210: one Needs you list. Example data only. Never Ash's chats.
// Shots land in after/. The before shots are taken from the unchanged code, separately.
test.use({ viewport: { width: 1440, height: 900 } });

const AFTER = "docs/hivra/work/shots/wp-210/after";

// Element shots stay large enough to open. A badge or a one-line header is padded out to at least 320x120.
async function shotBox(page: Page, locator: Locator, path: string): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No box for ${path}`);
  const view = page.viewportSize() ?? { width: 1440, height: 900 };
  let x = box.x;
  let y = box.y;
  let width = box.width;
  let height = box.height;
  if (width < 320) {
    const extra = 320 - width;
    x = Math.max(0, x - extra / 2);
    width = Math.min(view.width - x, width + extra);
    if (width < 320) {
      const pull = Math.min(x, 320 - width);
      x -= pull;
      width += pull;
    }
  }
  if (height < 120) {
    const extra = 120 - height;
    y = Math.max(0, y - extra / 2);
    height = Math.min(view.height - y, height + extra);
    if (height < 120) {
      const pull = Math.min(y, 120 - height);
      y -= pull;
      height += pull;
    }
  }
  await page.screenshot({ path, clip: { x, y, width, height } });
}

const PROJECTS: SeedProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/Users/example/Projects/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/example/Projects/hivra" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "heart", folder: "/Users/example/Projects/nibbii" },
  { id: "safetube", name: "SafeTube", shortName: "SafeTube", iconShape: "play", folder: "/Users/example/Projects/safetube" },
];

function decision(
  project: string,
  key: string,
  question: string,
  agoMs: number,
  pick?: { options: string[]; recommended: string },
) {
  return {
    project,
    decisionKey: key,
    question: `Example: ${question}`,
    options: pick?.options ?? ["Yes", "No"],
    recommended: pick?.recommended ?? "Yes",
    askedBy: "lead-session",
    askedByMono: null,
    waiting: [],
    state: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    agoMs,
    version: 1,
  };
}

// EXO's one item is a stopped worker, so the rail chip, the header and the Mono line share one count.
// A failure only counts for six hours, so this worker's time comes from the page clock. The decisions are stamped the same way when the page starts.
function stoppedWorker(ownerSession: string, now: number) {
  return {
    id: "upload-build",
    ownerSession,
    ownerMono: "vg-game-lead",
    batchId: "turn-1",
    parentId: null,
    rootId: "upload-build",
    childSession: "example-worker-chat",
    requestId: "example-request",
    generation: 1,
    project: "vg-game",
    title: "Upload the playtest build",
    brief: "Upload the playtest build",
    goal: null,
    askIds: [],
    state: "failed",
    errorClass: "billing",
    error: "Example: Out of credits",
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: now - 4 * 60_000,
    updatedAt: now - 4 * 60_000,
    settledAt: now - 4 * 60_000,
    log: [],
    version: 1,
    mirroredVersion: 1,
    mirrorError: null,
  };
}

async function seedStoppedWorker(page: Page): Promise<void> {
  // A lead's chat, and its session id, exist once its row has been opened. Dropwave: Home lists no first mates, they
  // are in a project, so open EXO first.
  await page.locator("[data-hub-strip]").getByRole("button", { name: /^EXO/ }).first().click();
  const lead = page.locator("[data-mono-rail]").locator('button[aria-label^="EXO lead"]').first();
  await expect(lead).toBeVisible({ timeout: 20_000 });
  await lead.click({ force: true });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const roster = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>;
          return roster.find((mono) => mono.id === "vg-game-lead")?.sessionId ?? "";
        }),
      { timeout: 20_000 },
    )
    .not.toBe("");
  const ownerSession = await page.evaluate(() => {
    const roster = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>;
    return roster.find((mono) => mono.id === "vg-game-lead")!.sessionId!;
  });
  const now = await page.evaluate(() => Date.now());
  await page.evaluate((row) => {
    localStorage.setItem("monocode:dev-delegations", JSON.stringify([row]));
    (window as unknown as { __devDelegationsChanged(): void }).__devDelegationsChanged();
  }, stoppedWorker(ownerSession, now));
  // The feed that reads these rows lives on the open chat. Leaving before it reads drops the worker.
  await expect(page.locator("[data-mono-rail]").getByRole("button", { name: "1 needs you. See what needs you for EXO lead" })).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-hub-home]").getByRole("button", { name: "Home" }).click({ force: true });
  await expect(page.locator("[data-home]")).toBeVisible({ timeout: 15_000 });
}

test("rail, home, header, mono line and inbox share one Needs you list", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const shoot = testInfo.project.name === "chromium";
  if (shoot) mkdirSync(AFTER, { recursive: true });

  await page.addInitScript((rows) => {
    const now = Date.now();
    const decisions = rows.map((row) => {
      const { agoMs, ...rest } = row;
      const at = now - agoMs;
      return { ...rest, createdAt: at, updatedAt: at };
    });
    localStorage.setItem("monocode.colorScheme", "dark");
    // The four ready-made pages ask for access on a fresh setup. This shot is the decisions and the stopped worker.
    localStorage.setItem("monocode:ready-pages-seeded-v2", "1");
    localStorage.setItem("monocode:dev-decisions", JSON.stringify(decisions));
  }, [
    decision("hivra", "windows-build", "Which version should the landing page use?", 20 * 60_000, {
      options: ["Ship 1.4.2", "Wait for 1.4.3"],
      recommended: "Ship 1.4.2",
    }),
    decision("hivra", "merge-217", "Ready to merge #217.", 9 * 60_000),
    decision("nibbii", "npm-publish", "frank wants to run npm publish in nibbii-web.", 2 * 60_000),
    decision("safetube", "weekly-views", "The Weekly views page asks to read YouTube stats.", 60_000),
  ]);
  await openLocalHub(page, "", PROJECTS);
  await expect(page.locator("[data-hub-strip]")).toBeVisible({ timeout: 60_000 });
  // The hub opens on Home. Clicking that button again never settles.
  await expect(page.locator("[data-home]")).toBeVisible({ timeout: 30_000 });
  await seedStoppedWorker(page);
  await expect(page.locator("[data-home-loading]")).toHaveCount(0, { timeout: 30_000 });

  const rail = (id: string) => page.locator(`[data-hub-strip] [data-project-id="${id}"] [data-needs-count]`);
  const agree = async (total: string, hivra: string) => {
    await expect(rail("hivra")).toHaveAttribute("data-needs-count", hivra, { timeout: 30_000 });
    await expect(rail("vg-game")).toHaveAttribute("data-needs-count", "1", { timeout: 30_000 });
    await expect(rail("nibbii")).toHaveAttribute("data-needs-count", "1");
    await expect(rail("safetube")).toHaveAttribute("data-needs-count", "1");
    await expect(page.locator("[data-home-count]")).toHaveAttribute("data-home-count", total);
    const marks = page.locator("[data-inbox-needs]");
    await expect(marks.first()).toHaveAttribute("data-inbox-needs", total);
    const count = await marks.count();
    for (let i = 1; i < count; i++) await expect(marks.nth(i)).toHaveAttribute("data-inbox-needs", total);
    const chip = rail("hivra");
    await expect(chip).toHaveCSS("background-color", "rgb(229, 72, 77)");
  };

  await agree("5", "2");

  const needs = page.locator("[data-home-section='needs-you']");
  await needs.scrollIntoViewIfNeeded();
  const needsText = (await needs.innerText()).replace(/\s+/g, " ");
  expect(needsText).not.toMatch(/\bStuck\b/);
  expect(needsText).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{8,}/i);
  expect(needsText).toContain("Open chat");
  expect(needsText).not.toContain("Open EXO lead's chat");
  expect(needsText).toContain("Stopped");
  expect(needsText).toContain("Example: Out of credits");
  const title = needs.locator("h2");
  expect(await title.evaluate((el) => el.nextElementSibling?.getAttribute("data-home-count") ?? "")).toBe("5");
  // Dropwave's Home row: the project's tag, a red "Stopped." and the reason, then Open chat.
  const stopped = needs.locator("[data-home-line]").filter({ has: page.locator("[data-home-stopped]") });
  await expect(stopped).toHaveCount(1);
  await expect(needs.locator("[data-home-line]").first().locator("[data-home-stopped]")).toHaveCount(1);
  const order = (await needs.innerText()).replace(/\s+/g, " ");
  const stoppedAt = order.indexOf("Example: Out of credits");
  const mergeAt = order.indexOf("Ready to merge");
  const askAt = order.indexOf("Which version should the landing page use?");
  expect(stoppedAt).toBeGreaterThanOrEqual(0);
  expect(mergeAt).toBeGreaterThan(stoppedAt);
  expect(askAt).toBeGreaterThan(mergeAt);
  await expect(stopped.locator("[data-home-project]")).toHaveText("EXO");
  await expect(stopped.locator("[data-home-stopped]")).toHaveText("Stopped.");
  await expect(stopped.locator("[data-home-stopped]")).toHaveCSS("color", "rgb(255, 107, 107)");
  await expect(stopped.locator("[data-needs-stopped]")).toHaveCount(0);
  const openChat = stopped.getByRole("button", { name: "Open chat" });
  expect(Number.parseFloat(await openChat.evaluate((el) => getComputedStyle(el).borderTopWidth))).toBeGreaterThan(0);
  await expect(openChat).not.toHaveClass(/bg-accent/);
  const windows = needs.locator("[data-home-line]").filter({ hasText: "Which version should the landing page use?" });
  const answer = windows.getByRole("button", { name: "Ship 1.4.2", exact: true });
  const otherWay = windows.getByRole("button", { name: "Open", exact: true });
  await expect(otherWay).toHaveCount(1);
  await expect(answer).toHaveClass(/bg-accent/);
  await expect(answer).not.toHaveClass(/primary-action/);
  const paint = await answer.evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.background = "var(--color-accent)";
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { got: getComputedStyle(el).backgroundColor, expected };
  });
  expect(paint.got).toBe(paint.expected);
  expect(paint.got).not.toBe("rgb(255, 255, 255)");
  const bordered = async (button: Locator) => {
    await expect(button).not.toHaveClass(/bg-accent/);
    expect(Number.parseFloat(await button.evaluate((el) => getComputedStyle(el).borderTopWidth))).toBeGreaterThan(0);
  };
  await bordered(otherWay);
  const publish = needs.locator("[data-home-line]").filter({ hasText: "npm publish" });
  const publishOpen = publish.getByRole("button", { name: "Open", exact: true });
  await expect(publishOpen).toHaveCount(1);
  await bordered(publishOpen);
  await expect(publish.getByRole("button", { name: "Allow once" })).toHaveCount(0);
  await expect(publish.getByRole("button", { name: "Deny" })).toHaveCount(0);
  const weekly = needs.locator("[data-home-line]").filter({ hasText: "Weekly views" });
  const review = weekly.getByRole("button", { name: "Open", exact: true });
  await expect(review).toHaveCount(1);
  await expect(weekly.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0);
  await expect(weekly.getByRole("button", { name: "Deny" })).toHaveCount(0);
  await expect(weekly.getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
  await bordered(review);
  const mergeRow = needs.locator("[data-home-line]").filter({ hasText: "Ready to merge" });
  const mergeOpen = mergeRow.getByRole("button", { name: "Open", exact: true });
  await expect(mergeOpen).toHaveCount(1);
  await bordered(mergeOpen);
  await expect(mergeRow.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0);
  await expect(mergeRow.getByRole("button", { name: "Not yet" })).toHaveCount(0);
  await expect(mergeRow.getByRole("button", { name: "Yes", exact: true })).toHaveCount(0);
  const dot = needs.locator("[data-home-mark='needs-you']");
  await expect(dot).toHaveCount(1);
  await expect(dot).toHaveCSS("background-color", "rgb(255, 107, 107)");
  const count = needs.locator("[data-home-count]");
  await expect(count).not.toHaveCSS("color", "rgb(229, 72, 77)");
  await expect(count).not.toHaveClass(/text-red/);
  const rowCount = await needs.locator("[data-home-line]").count();
  for (let i = 0; i < rowCount; i++) {
    expect(await needs.locator("[data-home-line]").nth(i).innerText()).toContain("Example:");
  }
  // Dropwave's Home has no Projects card: each project's count is on the strip (checked in agree), and the first
  // mates are in their project, so the Mono line is checked there below.
  const monoLine = page.locator("[data-mono-rail]").getByRole("button", { name: "1 needs you. See what needs you for EXO lead" });

  if (shoot) {
    await page.screenshot({ path: `${AFTER}/home.png` });
    await shotBox(page, page.locator("[data-hub-strip]"), `${AFTER}/rail.png`);
    await shotBox(page, page.locator("[data-inbox-needs]").first(), `${AFTER}/inbox.png`);
  }

  await page.locator('[data-hub-strip] [data-project-id="vg-game"]').click({ force: true });
  const header = page.locator("[data-hub-project-header]");
  await expect(header).toHaveAttribute("data-project-id", "vg-game");
  await expect(header.locator("[data-project-needs]")).toHaveAttribute("data-project-needs", "1");
  // The project's sidebar carries the whole list's total, and the lead's line its own.
  await expect(page.locator("[data-sidebar-needs-count]")).toHaveAttribute("data-sidebar-needs-count", "5");
  await expect(monoLine).toBeVisible();
  if (shoot) await shotBox(page, header, `${AFTER}/header.png`);

  await monoLine.click({ force: true });
  const panel = page.locator("[data-stuck-panel]");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Needs you");
  await expect(panel).toContainText("Open EXO lead's chat");
  await expect(panel).toContainText("Out of credits");
  const panelText = (await panel.innerText()).replace(/\s+/g, " ");
  expect(panelText).not.toMatch(/\bStuck\b/);
  expect(panelText).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{8,}/i);
  const chipWord = panel.locator("[data-hub-chip]");
  await expect(chipWord).toHaveText("Needs you");
  await expect(chipWord).toHaveCSS("color", "rgb(255, 107, 107)");
  const panelOpen = panel.getByRole("button", { name: "Open EXO lead's chat" });
  const dismiss = panel.getByRole("button", { name: "Dismiss" });
  await bordered(panelOpen);
  await bordered(dismiss);
  if (shoot) await page.screenshot({ path: `${AFTER}/mono.png` });

  await page.locator("[data-hub-home]").getByRole("button", { name: "Home" }).click({ force: true });
  await expect(page.locator("[data-home]")).toBeVisible();
  await page.locator("[data-home-line]").filter({ hasText: "Which version should the landing page use?" }).locator("[data-needs-answer]").click();
  await expect.poll(async () => page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem("monocode:dev-decisions") ?? "[]") as Array<{ decisionKey?: string; answer?: string | null }>;
    return rows.find((row) => row.decisionKey === "windows-build")?.answer ?? "";
  })).toBe("Ship 1.4.2");
  await agree("4", "1");
  await expect(page.locator("[data-home-section='needs-you']")).not.toContainText("Which version should the landing page use?");
  if (shoot) await page.screenshot({ path: `${AFTER}/answered.png` });
});
