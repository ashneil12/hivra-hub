import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import { PNG } from "pngjs";
import { seedExampleRoster } from "./exampleRoster";
import { openLocalHub } from "./localHub";
import { ringContrast } from "./contrastProbe";

// Round 30f proof (the real app in a browser, light theme, not Ash's Mac; made-up data labelled Example:): the room
// confirm and the Mono confirm, each as first shown, with Cancel's focus ring and its contrast measured from the
// rendered pixels (ring against the dialog's glass right outside it, and against the gap inside it). Both must be
// at least 3:1. Delete mono's second line says only what happens.
//   PM_PROOF_SPEC=pm-30f-confirm-light.spec.ts PM_PROOF_DIR=/workspace/pm-redo/proofs/on-r47 npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-30f";

const lum = ([r, g, b]: number[]) =>
  [r, g, b].map((v) => { const c = v! / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
};

/** Ring, gap and glass colours read off the screen above Cancel's top edge, and the ring's contrast with each. */
async function measuredRing(page: Page, cancel: Locator) {
  const box = (await cancel.boundingBox())!;
  const shot = PNG.sync.read(await page.screenshot());
  const scale = shot.width / page.viewportSize()!.width;
  const at = (x: number, y: number) => {
    const i = (Math.round(y * scale) * shot.width + Math.round(x * scale)) * 4;
    return [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
  };
  const x = box.x + box.width / 2;
  // Column above the button: gap (offset 2px), ring (2px), then the dialog's glass.
  const column = Array.from({ length: 10 }, (_, k) => at(x, box.y - 0.5 - k));
  const glass = column[9]!;
  const ring = column.reduce((best, c) => (ratio(c, glass) > ratio(best, glass) ? c : best), column[0]!);
  const gap = column[0]!;
  return { ring, gap, glass, againstGlass: ratio(ring, glass), againstGap: ratio(ring, gap) };
}

/** The red Delete label against its own button (r30g): text colour from the page, the button's fill read off the screen
 * in its left padding (its tint over the dialog, as Ash sees it). Needs 4.5:1 (small text). */
async function deleteLabel(page: Page, del: Locator) {
  const box = (await del.boundingBox())!;
  const shot = PNG.sync.read(await page.screenshot());
  const scale = shot.width / page.viewportSize()!.width;
  const i = (Math.round((box.y + box.height / 2) * scale) * shot.width + Math.round((box.x + 4) * scale)) * 4;
  const fill = [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
  const text = await del.evaluate((el) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = getComputedStyle(el).color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  });
  return { text, fill, ratio: ratio(text, fill) };
}

async function dialogClip(page: Page, dialog: Locator): Promise<string> {
  const box = (await dialog.boundingBox())!;
  const pad = 28;
  const buf = await page.screenshot({ clip: { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 } });
  return buf.toString("base64");
}

test("light theme: both confirms show Cancel's ring at 3:1 or more and a Delete label at 4.5:1 or more", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.addInitScript(() => localStorage.setItem("monocode.colorScheme", "light"));
  await seedExampleRoster(page);
  await openLocalHub(page);
  await expect(page.locator("html")).toHaveClass(/theme-light/, { timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 20_000 }).then(() => notNow.click(), () => undefined);

  // The room confirm.
  await page.locator("[data-hub-new-chat-button]").waitFor({ timeout: 60_000 });
  await page.evaluate(() => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect({ project: "hivra", item: "leadership-team" }));
  await page.locator('[data-hub-item="leadership-team"]').click();
  await page.locator("[data-hub-new-chat-button]").click();
  await page.getByRole("textbox").first().fill("Example: launch room");
  await page.locator("[data-hub-create-chat]").click();
  const roomRow = page.locator("[data-hub-room-row]", { hasText: "Example: launch room" });
  await expect(roomRow).toHaveCount(1, { timeout: 20_000 });
  await roomRow.hover();
  await roomRow.locator("[data-hub-room-delete]").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete “Example: launch room”?");
  let cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const roomRing = await measuredRing(page, cancel);
  const roomDelete = await deleteLabel(page, dialog.getByRole("button", { name: "Delete", exact: true }));
  const tokens = await ringContrast(page);
  const roomShot = await dialogClip(page, dialog);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(roomRow).toHaveCount(1);

  // The Mono confirm.
  const row = page.locator("[data-mono-status]", { hasText: "Ada" }).first();
  await row.hover();
  await row.locator('button[title="Mono options"]').click();
  const nameBox = page.getByRole("textbox", { name: "Mono name" });
  await nameBox.fill("Example: Pip");
  await nameBox.press("Enter");
  const pip = page.locator("[data-mono-status]", { hasText: "Example: Pip" }).first();
  // Open its chat once, so it has one to delete (the dev data's Monos start with none).
  await pip.locator("button[title]").first().click();
  await expect
    .poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { name?: string; sessionId?: string }[]).find((m) => m.name === "Example: Pip")?.sessionId ?? null), { timeout: 20_000 })
    .not.toBeNull();
  await pip.hover();
  await pip.locator('button[title="Mono options"]').click();
  await page.getByRole("menuitem", { name: "Delete mono…" }).click();
  await expect(dialog).toContainText("Delete “Example: Pip”?");
  cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const monoRing = await measuredRing(page, cancel);
  const monoDelete = await deleteLabel(page, dialog.getByRole("button", { name: "Delete", exact: true }));
  const monoShot = await dialogClip(page, dialog);
  const monoText = (await dialog.innerText()).replace(/\s+/g, " ");
  await page.keyboard.press("Enter");
  await expect(pip).toHaveCount(1);

  const report = { tokens, room: roomRing, mono: monoRing, roomDelete, monoDelete };
  console.log("light ring", JSON.stringify(report));
  fs.writeFileSync(`${SHOTS}/pm-30f-confirm-light.json`, JSON.stringify(report, null, 2));

  const rgb = (c: number[]) => `rgb(${c.join(", ")})`;
  const caption = (label: string, r: Awaited<ReturnType<typeof measuredRing>>, d: Awaited<ReturnType<typeof deleteLabel>>) =>
    `<p><b>${label}</b> — Cancel focused on open. Ring ${rgb(r.ring)} vs dialog glass ${rgb(r.glass)}: <b>${r.againstGlass}:1</b>; vs gap ${rgb(r.gap)}: <b>${r.againstGap}:1</b> (needs 3:1).<br>Delete label ${rgb(d.text)} vs its button ${rgb(d.fill)}: <b>${d.ratio}:1</b> (needs 4.5:1).</p>`;
  await page.setContent(`<html><body style="margin:0;width:1512px;background:#f4f4f5;font:14px -apple-system,system-ui,sans-serif;color:#18181b">
    <div style="padding:28px 40px">
      <h1 style="font-size:18px;margin:0 0 6px">r30f + r30g — the shared delete confirm in the light theme (browser, Example: data)</h1>
      <p style="margin:0 0 20px">Needs 3:1. The plain accent ${rgb(tokens.accent)} on the light surface ${rgb(tokens.surface)} would be only ${tokens.ratio}:1, so in the light theme the ring is the accent mixed toward the text colour (measured below from the screen).</p>
      <div style="display:flex;gap:40px;align-items:flex-start">
        <div>${caption("Room", roomRing, roomDelete)}<img src="data:image/png;base64,${roomShot}" style="border:1px solid #d4d4d8;border-radius:8px"></div>
        <div>${caption("Mono", monoRing, monoDelete)}<img src="data:image/png;base64,${monoShot}" style="border:1px solid #d4d4d8;border-radius:8px"></div>
      </div>
      <p style="margin-top:20px">Delete mono's text as shown: “${monoText}”</p>
    </div></body></html>`);
  await page.screenshot({ path: `${SHOTS}/pm-30f-confirm-light-1512.png`, fullPage: true });

  for (const d of [roomDelete, monoDelete]) expect(d.ratio).toBeGreaterThanOrEqual(4.5);
  for (const r of [roomRing, monoRing]) {
    expect(r.againstGlass).toBeGreaterThanOrEqual(3);
    expect(r.againstGap).toBeGreaterThanOrEqual(3);
  }
  expect(monoText).toContain("Its current chat is stopped and moved to the trash with it, and its habits stop. Its files go to the trash for 30 days, and you can put them back.");
  expect(monoText).not.toContain("can't be undone");
});
