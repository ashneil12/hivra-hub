import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { seedExampleRoster } from "./exampleRoster";
import { openLocalHub, openProjectLead } from "./localHub";

const SHOTS = process.env.B8_PROOF_DIR ?? "test-results/b8";
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test.use({ viewport: { width: 1440, height: 900 } });

// B8 (Ash, 15 Oct 17:20): "You can't rename a new conversation at all. I don't know if it also renames itself after he
// gets the topic of the message. In general, pressing "new conversation" also shouldn't immediately create a new
// conversation. It should take you to the new conversation screen." / "The plus sign, what is it that you can attach
// anything? Because then usually there's a different variety of media that you might want to use."
// The real app in WebKit (hub-dev.html reading the app's own local store, with the stand-in Claude CLI behind the real Claude
// adapter): EXO's Leadership team. Press New conversation and back out, start one, name it, attach a photo and a file
// from the + menu, send; the Mono's request carries the photo's bytes and the file's path; rename the older one by
// double-click; reload and both names and the attachments are still there. Each step is photographed.
//   npx playwright test -c tests/browser/b8.config.ts

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PHOTO = { path: "/Users/ash/Desktop/hud-external-monitor.png", size: 68, data: PNG };
const NOTES = { path: "/Users/ash/Desktop/combo-notes.md", size: 120 };
type Prompt = { sessionId: string; text: string; content?: Array<Record<string, unknown>> };
const prompts = (page: Page) => page.evaluate(() => (window as unknown as { __fakeClaude: { prompts: Prompt[] } }).__fakeClaude.prompts);
const roomConvs = (page: Page) =>
  page.evaluate(() => {
    const rooms = JSON.parse(localStorage.getItem("monocode:hub-chats") ?? "[]") as Array<{ id: string; conversations: Array<{ title: string; named?: boolean; messages: Array<{ text: string; attachments?: Array<{ name: string; path: string }> }> }> }>;
    return rooms.find((r) => r.id === "vg-game:leadership")?.conversations ?? [];
  });
const composer = (page: Page) => page.locator(`[data-hub-chat] textarea[aria-label^="Message"]`).first();
const attach = async (page: Page, kind: "media" | "file", pick: { path: string }) => {
  // The picker returns this one; every file picked stays on "disk" (the app reads the photo again when it sends).
  await page.evaluate((p) => {
    const w = window as unknown as { __devPick?: unknown[]; __devDisk?: unknown[] };
    w.__devDisk = [...(w.__devDisk ?? []), p];
    w.__devPick = [p];
  }, pick);
  await page.locator("[data-hub-chat] button[aria-label='Attach files']").click();
  await expect(page.locator("[data-attach-menu]")).toBeVisible();
  await page.locator(`[data-attach-pick="${kind}"]`).click();
};

test("Leadership team: New conversation and back leaves nothing; named, attached and renamed conversations hold after a reload", async ({ page }) => {
  await seedExampleRoster(page);
  await page.addInitScript(() => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
  });
  await openLocalHub(page, "&fakeClaude");
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /^EXO/ }).first().click();
  await page.locator('[data-hub-item="leadership-team"]').click();
  await expect(page.locator("[data-hub-chat]")).toBeVisible();

  // 1. New conversation opens its screen; with nothing to go back to, Escape leaves it, and nothing was made.
  await page.locator("[data-hub-new-conversation]").click();
  await expect(page.locator("[data-hub-new-conversation-screen]")).toBeVisible();
  await shot(page, "1-new-conversation-screen");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-hub-new-conversation-screen]")).toHaveCount(0);
  await expect(page.locator("[data-hub-conversation]")).toHaveCount(0);
  expect(await roomConvs(page)).toEqual([]);

  // 2. His first message starts one, named from it; the host answers through the stand-in Claude.
  await composer(page).fill("whats the plan for pages");
  await composer(page).press("Enter");
  await expect(page.locator("[data-hub-conversation]")).toHaveCount(1);
  await expect(page.locator("[data-hub-conversation-title]")).toHaveText("whats the plan for pages");
  await expect.poll(async () => (await prompts(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator("[data-hub-chat]")).toContainText("Ada", { timeout: 30_000 });

  // 3. New conversation, then Back: the conversation he was in shows again, and there is still only one.
  await page.locator("[data-hub-new-conversation]").click();
  await expect(page.locator("[data-hub-conversation-draft]")).toBeVisible();
  await page.locator("[data-hub-new-conversation-back]").click();
  await expect(page.locator("[data-hub-new-conversation-screen]")).toHaveCount(0);
  await expect(page.locator("[data-hub-conversation-draft]")).toHaveCount(0);
  await expect(page.locator("[data-hub-conversation-title]")).toHaveText("whats the plan for pages");
  expect(await roomConvs(page)).toHaveLength(1);
  await shot(page, "2-back-nothing-left");

  // 4. A new one, named before its first message by double-clicking "New conversation".
  await page.locator("[data-hub-new-conversation]").click();
  await page.locator("[data-hub-conversation-draft]").dblclick();
  await page.locator("[data-hub-conversation-rename]").fill("HUD crispness");
  await page.locator("[data-hub-conversation-rename]").press("Enter");
  await expect(page.locator("[data-hub-conversation-draft-title]")).toHaveText("HUD crispness");
  expect(await roomConvs(page)).toHaveLength(1);

  // 5. + offers photos and videos or files: one of each.
  await page.locator("[data-hub-chat] button[aria-label='Attach files']").click();
  await expect(page.locator("[data-attach-menu]")).toContainText("Photo or image");
  await expect(page.locator("[data-attach-menu]")).toContainText("File");
  await shot(page, "3-plus-menu");
  await page.keyboard.press("Escape");
  await attach(page, "media", PHOTO);
  await attach(page, "file", NOTES);
  // The chip just landed under the pointer, and a hovered element's title is held aside for the in-page tip
  // (titleTips.ts, r72): move away so the title is back.
  await page.mouse.move(5, 5);
  await expect(page.locator("[data-hub-chat] form [title='/Users/ash/Desktop/combo-notes.md']")).toBeVisible();
  await composer(page).fill("cos the hud looks soft on the external monitor, see pic + my notes");
  await shot(page, "4-attached-before-send");
  const before = (await prompts(page)).length;
  await composer(page).press("Enter");

  // It is his conversation by his name, with both files on the message.
  await expect(page.locator("[data-hub-conversation]")).toHaveCount(2);
  await expect(page.locator("[data-hub-conversation-title]")).toHaveText("HUD crispness");
  await expect(page.locator("[data-hub-msg-attachment]")).toHaveCount(2);
  const convs = await roomConvs(page);
  expect(convs[0]).toMatchObject({ title: "HUD crispness", named: true });
  expect(convs[0].messages[0].attachments!.map((a) => a.path)).toEqual([PHOTO.path, NOTES.path]);

  // 6. The Mono's request, as the Claude CLI got it on stdin: the photo as an image with its bytes, the file by its path.
  await expect.poll(async () => (await prompts(page)).length, { timeout: 30_000 }).toBeGreaterThan(before);
  const turn = (await prompts(page)).slice(before).find((p) => p.text.includes("the hud looks soft"))!;
  expect(turn).toBeTruthy();
  expect(turn.content).toContainEqual(expect.objectContaining({ type: "image", source: expect.objectContaining({ type: "base64", media_type: "image/png", data: PNG }) }));
  expect(turn.text).toContain(JSON.stringify(NOTES.path));
  await expect(page.locator("[data-hub-chat]")).toContainText("Ada", { timeout: 30_000 });
  await shot(page, "5-sent-with-attachments");

  // 7. Double-click the older conversation to rename it.
  const older = page.locator("[data-hub-conversation]").nth(1);
  await older.dblclick();
  await page.locator("[data-hub-conversation-rename]").fill("Pages plan");
  await page.locator("[data-hub-conversation-rename]").press("Enter");
  await expect(page.locator("[data-hub-conversation]").nth(1)).toContainText("Pages plan");
  await expect(page.locator("[data-hub-conversation-title]")).toHaveText("Pages plan");
  // A later message in it never renames it.
  await composer(page).fill("also what about the github component packs");
  await composer(page).press("Enter");
  await expect(page.locator("[data-hub-conversation-title]")).toHaveText("Pages plan");
  await shot(page, "6-renamed");

  // 8. Reload (the window rebuilt from what was saved): both names, and the attachments, are still there.
  await page.reload();
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  // A fresh load opens the coding team. Leadership team is a real leave: it closes that Lead.
  await page.getByRole("button", { name: "Leadership team", exact: true }).click();
  await expect(page.locator("[data-hub-conversation]")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator("[data-hub-conversation]").nth(0)).toContainText("HUD crispness");
  await expect(page.locator("[data-hub-conversation]").nth(1)).toContainText("Pages plan");
  await page.locator("[data-hub-conversation]").nth(0).click();
  await expect(page.locator("[data-hub-msg-attachment]")).toHaveCount(2);
  const after = await roomConvs(page);
  expect(after.map((c) => [c.title, !!c.named])).toEqual([["HUD crispness", true], ["Pages plan", true]]);
  await shot(page, "7-after-reload");
});

// The coding team, where Ash talks most (Ash, 20 Oct): New session opens the new-session screen and backing out to the
// Lead leaves no empty chat in the list; a chat is renamed by double-click as well as F2 and the menu.
test("Coding team: New session and back leaves no empty chat; double-click renames a chat", async ({ page }) => {
  const now = Date.now();
  await page.addInitScript((at) => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    const chat = {
      id: "b8-save-bug", cwd: "/Users/example/Projects/vg-game", harness: "claude", model: "claude:sonnet-5", runtimeMode: "supervised",
      title: "Claude · the save bug on mission two", createdAt: at - 3_600_000, updatedAt: at - 60_000,
      blocks: [{ id: "u", role: "user", text: "the save bug on mission two, can u sort it" }, { id: "a", role: "assistant", text: "On it." }],
    };
    localStorage.setItem("monocode:dev-sessions", JSON.stringify([chat]));
    localStorage.setItem("monocode:coding-team-chats", JSON.stringify({ "b8-save-bug": "vg-game" }));
  }, now);
  await openLocalHub(page, "&fakeClaude");
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  // Dropwave: the project opens on its home; its first mate, under First mates, opens the coding team's chats.
  await openProjectLead(page);
  await expect(page.locator("[data-coding-team-lead]")).toBeVisible({ timeout: 15_000 });
  const cards = () => page.locator("[data-session-card]").evaluateAll((els) => els.map((e) => e.getAttribute("data-session-card")));
  const listed = await cards();
  expect(listed).toContain("b8-save-bug");

  await page.getByRole("button", { name: /New session/ }).first().click();
  const newScreen = page.locator("h1:visible", { hasText: "What should we work on in EXO?" });
  await expect(newScreen).toHaveCount(1);
  expect(await cards()).toEqual(listed);
  await shot(page, "8-coding-team-new-session");
  await page.locator("[data-coding-team-lead] [data-session-card]").click();
  await expect(newScreen).toHaveCount(0);
  expect(await cards()).toEqual(listed);

  // Ash double-clicks a chat he isn't in: the first click opens it, the second names it.
  await page.locator('[data-session-select="b8-save-bug"]').dblclick();
  const input = page.locator('input:not([aria-label="Search conversations"])');
  await expect(input).toBeVisible();
  await input.fill("Mission two save bug");
  await input.press("Enter");
  await expect(page.locator('[data-session-card="b8-save-bug"]')).toContainText("Mission two save bug");
  await shot(page, "9-coding-team-renamed");
  // Ash, 22 Oct (codingTeamList.ts leadRenameRow): the Lead's chat renames like any other chat once it exists, and
  // Escape leaves its name as it was.
  await page.locator("[data-coding-team-lead] [data-session-select]").dblclick();
  await expect(page.locator("[data-coding-team-lead] input")).toHaveCount(1);
  await page.locator("[data-coding-team-lead] input").press("Escape");
  await expect(page.locator("[data-coding-team-lead] input")).toHaveCount(0);
});
