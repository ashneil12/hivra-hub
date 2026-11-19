import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { openLocalHub, openProjectLead } from "./localHub";

// Idea 2 in the real app in a browser (hub-dev.html reading the app's own local store, ?fakeClaude for the Claude CLI): a coding
// team's own chat gets the Mono chat's Stop and model line, and its turn header names the model really in use.
// Example data only. A browser preview, not Ash's Mac.
const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-ui-ideas";
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
const seedClaude = (page: Page) =>
  page.addInitScript(() => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
  });

test("a coding team's own chat: Stop in the send spot during a turn, its own turn only; the model line above the box", async ({ page }) => {
  const now = Date.now();
  await seedClaude(page);
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
  await openLocalHub(page, "&fakeClaude");
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  await closeOffer(page);
  // Dropwave: the project opens on its home; its first mate, under First mates, opens the coding team's chats.
  await openProjectLead(page);
  await page.locator(`[data-session-card="${TEAM_CHAT}"]`).click();
  const pane = page.locator("[data-composer-box]:visible").first().locator("xpath=ancestor::*[.//*[@data-mono-pick]][1]");
  const box = page.locator("[data-composer-box]:visible").first();
  const field = box.locator("textarea");
  await expect(field).toBeVisible({ timeout: 15_000 });

  // The model as text above the box, with a chevron; no model picker in the toolbar.
  const line = pane.locator("[data-mono-model-line]");
  await expect(line).toContainText("Sonnet 5");
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
  // No runner mascot while the model line shows: nothing floats on the line's rule.
  await page.waitForTimeout(600);
  expect(await page.locator(".pointer-events-none.fixed.inset-0.z-40 .origin-bottom svg").count()).toBe(0);
  // While the turn runs its header is the one live status line (what it does now, Critiquito 29 Oct), with no model
  // name or mark; once it ends the header names the model really in use. The catalog calls claude:sonnet-5 "Claude Sonnet 5".
  const chat = box.locator("xpath=ancestor::*[@data-session-drop][1]");
  const live = chat.getByRole("status").filter({ hasText: /^(Thinking|Writing)/ }).first();
  await expect(live).toBeVisible();
  // The model line in this chat names Sonnet 5. The live header does not.
  await expect(live).not.toContainText(/Sonnet|Claude|Grok/);
  expect(await chat.locator('img[src*="claude"]').count()).toBe(0);
  // The chat's last lines too (the turn's working mark sits just above the model line), then the composer.
  // The whole chat (its title, the turn and the composer), as Ash sees it in EXO's coding team.
  const chatBox = (await box.locator("xpath=ancestor::*[@data-session-drop][1]").boundingBox())!;
  await area(page, "pm-ui-2b-coding-team-stop", chatBox, 0);

  // Stop stops this chat's turn: an interrupt for this chat only, nothing handed out is stopped.
  await stop.click();
  await expect.poll(() => fake<Array<{ sessionId: string; kind: string }>>(page, "stops")).toContainEqual({ sessionId: TEAM_CHAT, kind: "interrupt" });
  expect((await fake<Array<{ kind: string }>>(page, "stops")).filter((s) => s.kind === "stop_task")).toEqual([]);
  await expect(box.locator('[aria-label="Send"]')).toBeVisible({ timeout: 15_000 });
  await expect(chat.getByText(/^Claude Sonnet 5 worked/)).toBeVisible();
  await expect(chat.getByText(/Grok/)).toHaveCount(0);
});
