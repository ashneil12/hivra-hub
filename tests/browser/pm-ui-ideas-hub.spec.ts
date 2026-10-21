import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Ideas 2 and 4 in the real app in a browser (hub-dev.html reading the stub Ash OS, ?fakeClaude for the Claude CLI):
// a coding team's own chat gets the Mono chat's Stop and model line; and the real Monos rail says "Not sure" once a
// chat seen running has left the window for 8 s. Example data only. A browser preview, not Ash's Mac.
const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-ui-ideas";
type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

const FOLDER = "/Users/example/Projects/vg-game";
const TEAM_CHAT = "6f1c2a9e-save";
const fake = <T,>(page: Page, read: string) => page.evaluate((code) => new Function(`return window.__fakeClaude.${code}`)() as T, read);
const next = (page: Page, what: string) => page.evaluate((w) => (window as unknown as { __fakeClaude: { next: string[] } }).__fakeClaude.next.push(w), what);
const closeOffer = async (page: Page) => {
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
};
/** A photo cut to one part of the screen, with a margin. */
const area = async (page: Page, name: string, box: { x: number; y: number; width: number; height: number }, pad = 16) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x, y, width: box.width + 2 * pad, height: box.height + 2 * pad } });
};
const onGrokBridge = (page: Page) =>
  page.addInitScript(() => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
    // Claude Code on Grok 4.7 through the bridge launcher, as on Ash's Mac (claudeGrokBridge.ts).
    localStorage.setItem("monocode.providerBinaryPaths.v1", JSON.stringify({ claude: "/Users/ash/.local/bin/claude-grok" }));
  });

test("a coding team's own chat: Stop in the send spot during a turn, its own turn only; the model line above the box", async ({ page }) => {
  const now = Date.now();
  await onGrokBridge(page);
  await page.addInitScript(
    ({ chat, folder, at }) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(
        "monocode:dev-sessions",
        JSON.stringify([
          {
            id: chat, cwd: folder, harness: "claude", model: "claude:sonnet-5", runtimeMode: "supervised", title: "Example: Fix the save bug",
            createdAt: at - 3_600_000, updatedAt: at - 60_000,
            blocks: [
              { id: "b1", role: "user", text: "Example: the save bug on mission two, can you sort it" },
              { id: "b2", role: "assistant", text: "Example: Got it. One worker is checking mission two saves." },
            ],
          },
        ]),
      );
      localStorage.setItem("monocode:coding-team-chats", JSON.stringify({ [chat]: "vg-game" }));
    },
    { chat: TEAM_CHAT, folder: FOLDER, at: now },
  );
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}&fakeClaude`);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  await closeOffer(page);
  await page.getByRole("button", { name: /^EXO/ }).first().click();
  await page.locator(`[data-session-card="${TEAM_CHAT}"]`).click();
  const pane = page.locator("[data-composer-box]:visible").first().locator("xpath=ancestor::*[.//*[@data-mono-pick]][1]");
  const box = page.locator("[data-composer-box]:visible").first();
  const field = box.locator("textarea");
  await expect(field).toBeVisible({ timeout: 15_000 });

  // The model as text above the box, Grok 4.7 on the bridge, with a chevron; no model picker in the toolbar.
  const line = pane.locator("[data-mono-model-line]");
  await expect(line).toContainText("Grok 4.7");
  await expect(pane.locator("[data-model-menu]")).toBeVisible();
  await expect(box.locator("button[aria-haspopup]").filter({ hasText: /Sonnet|Claude/ })).toHaveCount(0);

  const send = box.locator('[aria-label="Send"]');
  await expect(send).toBeVisible();
  const sendBox = (await send.boundingBox())!;

  // A turn runs and the box is empty: the send spot is the grey Stop, same size and place.
  await next(page, "hold");
  await field.fill("Example: check the mission two save again");
  await field.press("Enter");
  const stop = box.locator("[data-mono-stop]");
  await expect(stop).toBeVisible({ timeout: 15_000 });
  expect(await stop.boundingBox()).toEqual(sendBox);
  expect(await stop.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgb\(255, 255, 255\)/);
  // Typing brings Send back mid-turn; clearing it shows Stop again.
  await field.fill("Example: one more thing");
  await expect(box.locator('[aria-label="Send"]')).toBeVisible();
  await field.fill("");
  await expect(stop).toBeVisible();
  await closeOffer(page);
  await page.mouse.move(1300, 100);
  // The turn's runner (ComposerRunner) runs the model line's rule, never over the model text or the box.
  const rule = (await pane.locator("[data-model-line-rule]").boundingBox())!;
  await page.waitForTimeout(600);
  const runner = await page.evaluate(() => {
    const sprite = document.querySelector(".pointer-events-none.fixed.inset-0.z-40 .origin-bottom svg");
    const r = sprite?.getBoundingClientRect();
    return r ? { left: r.left, right: r.right, bottom: r.bottom } : null;
  });
  expect(runner).not.toBeNull();
  expect(runner!.right).toBeLessThanOrEqual(rule.x + rule.width + 2);
  expect(Math.abs(runner!.bottom - rule.y)).toBeLessThan(6);
  // The chat's last lines too (the turn's working mark sits just above the model line), then the composer.
  // The whole chat (its title, the turn and the composer), as Ash sees it in EXO's coding team.
  const chatBox = (await box.locator("xpath=ancestor::*[@data-session-drop][1]").boundingBox())!;
  await area(page, "pm-ui-2b-coding-team-stop", chatBox, 0);

  // Stop stops this chat's turn: an interrupt for this chat only, nothing handed out is stopped.
  await stop.click();
  await expect.poll(() => fake<Array<{ sessionId: string; kind: string }>>(page, "stops")).toContainEqual({ sessionId: TEAM_CHAT, kind: "interrupt" });
  expect((await fake<Array<{ kind: string }>>(page, "stops")).filter((s) => s.kind === "stop_task")).toEqual([]);
  await expect(box.locator('[aria-label="Send"]')).toBeVisible({ timeout: 15_000 });
});

test("the real rail: a Mono whose running chat left the window reads Not sure from 8 s, faded and still", async ({ page }) => {
  await onGrokBridge(page);
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}&fakeClaude`);
  const rail = page.locator("[data-mono-rail]").first();
  await expect(rail).toBeVisible({ timeout: 60_000 });
  await closeOffer(page);
  const cosRow = rail.locator('button[aria-label^="Chief of Staff"]').first();
  await cosRow.click();
  const field = page.getByLabel("Message Chief of Staff");
  await expect(field).toBeVisible({ timeout: 15_000 });
  await next(page, "hold");
  await field.fill("Example: draft the week's plan");
  await field.press("Enter");
  const row = rail.locator('[data-mono-status]').filter({ has: page.locator('button[aria-label^="Chief of Staff"]') }).first();
  await expect(row).toHaveAttribute("data-mono-status", "working", { timeout: 15_000 });
  const chat = await page.evaluate(
    () => (JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Array<{ id: string; sessionId?: string }>).find((m) => m.id === "chief-of-staff")?.sessionId ?? "",
  );
  expect(chat).not.toBe("");

  // Off the chat (Today), then the chat leaves this window mid-turn, as a move to another window does (dev hook).
  await page.locator('[data-hub-strip] button[title="Today, all projects"]').click();
  const left = Date.now();
  await page.evaluate((id) => (window as unknown as { __devChatLeavesWindow(id: string): void }).__devChatLeavesWindow(id), chat);
  // Under 8 s it is not "Not sure" yet; from 8 s it is, and stays.
  await page.waitForTimeout(6500);
  await expect(row).not.toHaveAttribute("data-mono-status", "unknown");
  await expect(row).toHaveAttribute("data-mono-status", "unknown", { timeout: 6000 });
  expect(Date.now() - left).toBeGreaterThanOrEqual(8000);
  await expect(cosRow).toHaveAttribute("title", /Not sure/);
  await expect(cosRow).toHaveAttribute("aria-label", /Not sure/);
  await expect(row.locator("[data-mono-unsure] svg.pixel-mascot")).toHaveClass(/opacity-40/);
  await expect(row.locator(".pixel-bob, .pixel-hop")).toHaveCount(0);
  await expect(row.locator("[data-mono-dot]")).toHaveClass(/bg-content\/30/);
  await closeOffer(page);
  await cosRow.hover();
  const railBox = (await rail.boundingBox())!;
  await area(page, "pm-ui-4-not-sure-rail", { ...railBox, height: Math.min(railBox.height, 320) }, 4);
  await page.evaluate(() => (window as unknown as { __fakeClaude: { release(): void } }).__fakeClaude.release());
});
