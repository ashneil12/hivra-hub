import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { openLocalHub, openProjectLead } from "./localHub";

// F2 (r53): a worker chat's "Worked for … · Jump in" bar floats over its transcript on glass, so the last lines scroll
// on under it, blurred, instead of stopping at a hard edge; and the tab strip is glass over the page under it. Dark and
// light. The real app in a browser (hub-dev.html on the local store), a worker sub-chat with a long transcript.
//
//   STUCK_PROOF_PORT=1523 PROOF_SPEC=glass-dock.spec.ts npx playwright test -c tests/browser/stuck-workers.config.ts

const SHOTS = process.env.GLASS_PROOF_DIR ?? "test-results/glass-dock";
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test.use({ viewport: { width: 1440, height: 900 } });

const FOLDER = "/Users/example/Projects/vg-game";
const TEAM_CHAT = "6f1c2a9e-save";
const WORKER = `app-${TEAM_CHAT}-t-5`;

function chats(now: number) {
  const chat = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
    id, cwd: FOLDER, harness: "claude", model: "claude:sonnet-5", runtimeMode: "supervised", title,
    createdAt: now - 3_600_000, updatedAt: now - 60_000, ...patch,
  });
  const long = Array.from({ length: 14 }, (_, i) => ({
    id: `w${i + 2}`,
    role: "assistant",
    text: `Step ${i + 1}: read the mission two save path and checked the slot index against the autosave marker; the write lands in the slot before the checkpoint flag flips, so a reload between them restores the earlier checkpoint.`,
  }));
  return [
    chat(TEAM_CHAT, "Fix the save bug"),
    chat(WORKER, "Check mission two saves", {
      runtimeMode: "full-access",
      blocks: [{ id: "w1", role: "user", text: "[MonoCode brief from EXO coding team]\n\nCheck that mission two saves." }, ...long],
    }),
  ];
}

function rows(now: number) {
  return [{
    id: "t-5", ownerSession: TEAM_CHAT, ownerMono: null, batchId: "turn-1", parentId: null, rootId: "t-5",
    childSession: WORKER, requestId: "r-t-5", generation: 1, project: "vg-game", title: "Check mission two saves",
    brief: "Check mission two saves", goal: null, askIds: [], state: "running", errorClass: null, error: null,
    retryable: null, resetsAt: null, result: null, pendingQuestion: null, delivery: "pending", deliveryMessage: null,
    createdAt: now - 30 * 60_000, updatedAt: now - 60_000, settledAt: null, log: [], version: 1, mirroredVersion: 1,
    mirrorError: null,
  }];
}

const look = (page: Page) =>
  page.evaluate(() => {
    const bar = [...document.querySelectorAll<HTMLElement>("[data-delegated-chat]")].find((e) => e.getBoundingClientRect().width > 0)!;
    const pane = bar.closest("[data-session-composer]")!.parentElement!;
    const scroller = pane.querySelector<HTMLElement>(".agent-transcript")!;
    const header = document.querySelector<HTMLElement>("[data-inset-title-bar]");
    const b = bar.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const css = getComputedStyle(bar);
    const hcss = header ? getComputedStyle(header) : null;
    return {
      barBackdrop: css.backdropFilter, barBg: css.backgroundColor, barTop: b.top, barBottom: b.bottom,
      scrollerBottom: s.bottom, dockClear: getComputedStyle(pane).getPropertyValue("--dock-clear"),
      headerBackdrop: hcss?.backdropFilter ?? null, headerBg: hcss?.backgroundColor ?? null,
      scrollerTop: s.top, headerBottom: header?.getBoundingClientRect().bottom ?? null,
    };
  });

test("a worker chat's bar and the tab strip are glass over the scrolling transcript, dark and light", async ({ page }) => {
  const now = Date.now();
  await page.addInitScript(
    ({ list, team }) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("monocode:dev-sessions", JSON.stringify(list));
      localStorage.setItem("monocode:coding-team-chats", JSON.stringify({ [team]: "vg-game" }));
    },
    { list: chats(now), team: TEAM_CHAT },
  );
  await openLocalHub(page);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  // Dropwave: the project opens on its home; its first mate, under First mates, opens the coding team's chats.
  await openProjectLead(page);
  await expect(page.locator(`[data-session-card="${TEAM_CHAT}"]`)).toBeVisible({ timeout: 15_000 });
  await page.evaluate((list) => {
    localStorage.setItem("monocode:dev-delegations", JSON.stringify(list));
    (window as unknown as { __devDelegationsChanged(): void }).__devDelegationsChanged();
  }, rows(now));
  await page.locator(`[data-sub-chats-toggle="${TEAM_CHAT}"]`).click();
  await page.locator(`[data-sub-chat="${WORKER}"]`).click();
  await expect(page.locator("[data-delegated-chat]:visible").first()).toBeVisible({ timeout: 10_000 });
  await page.mouse.move(1200, 500);

  await page.waitForTimeout(2000);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((light) => document.documentElement.classList.toggle("theme-light", light), theme === "light");
    // Scroll so a line sits under the bar.
    await page.evaluate(() => {
      const sc = document.elementFromPoint(900, 400)!.closest<HTMLElement>(".agent-transcript")!;
      sc.scrollTop = sc.scrollHeight;
    });
    await page.mouse.move(900, 500);
    await page.mouse.wheel(0, -140);
    await shot(page, `${theme}-under-bar`);
    const l = await look(page);
    console.log(theme, JSON.stringify(l));
    expect(l.barBackdrop).toContain("blur");
    expect(l.scrollerBottom).toBeGreaterThanOrEqual(l.barBottom - 1);
    // "Jump to latest" sits above the bar, not on it.
    const jump = await page.evaluate(() => {
      const b = document.elementFromPoint(900, 400)!.closest<HTMLElement>(".transcript-glass-dock")!.querySelector("[data-jump-to-bottom]");
      return b ? b.getBoundingClientRect().bottom : null;
    });
    expect(jump).not.toBeNull();
    expect(jump!).toBeLessThanOrEqual(l.barTop);
    await page.evaluate(() => {
      const sc = document.elementFromPoint(900, 400)!.closest<HTMLElement>(".agent-transcript")!;
      sc.scrollTop = sc.scrollHeight;
    });
    await shot(page, `${theme}-at-end`);
    // Mid-page, a line sits at the tab strip: the strip's glass edge blurs it.
    const edge = await page.evaluate(() => {
      const band = document.elementFromPoint(900, 400)!.closest<HTMLElement>(".transcript-glass-dock")!.querySelector<HTMLElement>("[data-tab-strip-glass]")!;
      return { backdrop: getComputedStyle(band).backdropFilter, top: band.getBoundingClientRect().top };
    });
    expect(edge.backdrop).toContain("blur");
    await page.evaluate(() => {
      const sc = document.elementFromPoint(900, 400)!.closest<HTMLElement>(".agent-transcript")!;
      sc.scrollTop = 150;
    });
    await shot(page, `${theme}-under-tabs`);
  }
});
