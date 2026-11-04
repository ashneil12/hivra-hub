import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { seedExampleRoster } from "./exampleRoster";
import { openLocalHub } from "./localHub";

// Round 20 proofs (a browser fixture, not Ash's Mac; tests/browser/agent-notes.tsx, made-up data labelled Example:):
// agent-to-agent notes in a Lead's chat (one quiet line, a clickable name; notes landing together fold into one line
// that expands), and a stuck item whose Open chat opens the Lead's chat, not the worker's (D5).
//   PM_PROOF_SPEC=pm-20-agent-notes.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-20";
test.use({ viewport: { width: 1100, height: 760 } });

test("a single note, a folded group collapsed and expanded", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/tests/browser/agent-notes.html");
  const single = page.locator("[data-agent-note]").first();
  await expect(single).toBeVisible({ timeout: 60_000 });
  // Round 21: the brief's line repeats the worker's label, so it is said once.
  // r91: a brief reads "handed a job to" (agentNotes.ts noteVerb).
  await expect(single).toHaveText('EXO lead handed a job to Worker "Example: fix the save bug"');
  const style = await single.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, radius: s.borderRadius, border: s.borderTopWidth, lines: Math.round(el.getBoundingClientRect().height / parseFloat(s.lineHeight)) };
  });
  expect(style).toEqual({ bg: "rgba(0, 0, 0, 0)", radius: "0px", border: "0px", lines: 1 }); // no bubble, one line
  await single.locator("[data-agent-note-open]").click();
  await expect(page.locator("[data-opened]")).toHaveAttribute("data-opened", "child:lead-chat>w-save");
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${SHOTS}/pm-20-note-single.png` });

  const fold = page.locator("[data-agent-note-fold]").first();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(fold).toHaveText("3 team notes");
  await expect(page.locator("[data-agent-note-group] [data-agent-note]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/pm-20-notes-folded.png` });
  await fold.click();
  await expect(page.locator("[data-agent-note-group]").first().locator("[data-agent-note]")).toHaveCount(3);
  // The music worker has no chat: plain text, no link.
  const music = page.locator("[data-agent-note-group] [data-agent-note]").nth(1);
  await expect(music).toContainText("swap the menu music");
  await expect(music.locator("button")).toHaveCount(0);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${SHOTS}/pm-20-notes-expanded.png` });
});

test("a stuck item's Open chat opens the Lead's chat, not the worker's", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.goto("/tests/browser/agent-notes.html?view=today");
  const open = page.locator("[data-stuck-open]").first();
  await expect(open).toBeVisible({ timeout: 60_000 });
  await expect(open).toHaveAttribute("title", /EXO lead's chat/);
  await page.screenshot({ path: `${SHOTS}/pm-20-stuck-before.png` });
  await open.click();
  await expect(page.locator("[data-opened]")).toHaveAttribute("data-opened", "owner:lead-chat");
  await expect(page.locator('[data-fixture-chat="lead-chat"]')).toBeVisible();
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${SHOTS}/pm-20-stuck-opens-lead-chat.png` });
});

// A8: a Mono's Sessions tab shows only running work; with none, it says so plainly (no ghost words).
test("A8: an empty Sessions list says nothing is running right now", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedExampleRoster(page);
    await openLocalHub(page);
    await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
    const notNow = page.getByRole("button", { name: "Not now" });
    await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => undefined);
    await page.locator("[data-mono-rail]").first().locator('button[aria-label^="Ada"]').first().click();
    await page.getByRole("tab", { name: /Sessions/ }).or(page.getByRole("button", { name: /^Sessions/ })).first().click();
    const empty = page.locator("[data-mono-sessions-empty]").first();
    await expect(empty).toBeVisible({ timeout: 15_000 });
    await expect(empty).toHaveText(/^Nothing running right now\. Sessions show here while Ada is working/);
    expect(await empty.textContent()).not.toMatch(/ghost/i);
    await page.mouse.move(5, 450);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/pm-20-sessions-empty.png` });
  }
});
