import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import { seedExampleRoster } from "./exampleRoster";
import { openLocalHub } from "./localHub";

// PM redo proofs (B8, G4, F3, C6, PM-20, PM-21) in the real app in a browser: hub-dev.html reading the app's own local store.
// One photo per screen. A browser preview only, not Ash's Mac.
//   PM_PROOF_SPEC=pm-redo.spec.ts npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-redo";
fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test.use({ viewport: { width: 1440, height: 900 } });

/** For each rail row with a creature: its status dot touches none of the creature's pixels nor the row's text, and stays inside its row. */
const dotsClear = (rail: Locator) =>
  rail.locator("button[aria-label][title]").evaluateAll((buttons) =>
    buttons
      .filter((b) => b.querySelector("svg.pixel-mascot") && b.querySelector("[data-mono-dot]"))
      .map((b) => {
        const dot = b.querySelector("[data-mono-dot]")!.getBoundingClientRect();
        const row = (b.closest(".reorder-item") as HTMLElement).getBoundingClientRect();
        const hits = [...b.querySelectorAll("svg.pixel-mascot rect")].some((r) => {
          const p = r.getBoundingClientRect();
          return p.width && p.height && p.left < dot.right && p.right > dot.left && p.top < dot.bottom && p.bottom > dot.top;
        });
        // Nor any letter of the row's text (the name, its role): the dot, with its 1px ring, has a gap of its own.
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        let onText = false;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim() || node.parentElement?.closest("svg, [data-mono-letter]")) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const t of range.getClientRects()) {
            if (t.width && t.left < dot.right + 1 && t.right > dot.left - 1 && t.top < dot.bottom + 1 && t.bottom > dot.top - 1) onText = true;
          }
        }
        return !hits && !onText && dot.top >= row.top && dot.bottom <= row.bottom;
      }),
  );

async function open(page: Page) {
  await seedExampleRoster(page);
  await openLocalHub(page);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => undefined);
}

const devSelect = (page: Page, selection: { project: string; item: string }) =>
  page.evaluate((sel) => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect(sel), selection);

// The whole roster on the rail: G1 filters it to the selected project's own Monos, and Autopilot belongs to no
// project (an app item keeps HubSurface from picking one), so it lists every Mono again, as these proofs need.
const showAllMonos = (page: Page) => devSelect(page, { project: "", item: "autopilot" });

test("B8: New conversation opens a screen with a pencil to name it; + offers Photo or image, or File", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^EXO/ }).first().click();
  await page.locator('[data-hub-item="leadership-team"]').click();
  await expect(page.locator("[data-hub-chat]")).toBeVisible();
  await page.locator("[data-hub-new-conversation]").click();
  await expect(page.locator("[data-hub-new-conversation-screen]")).toBeVisible();
  await expect(page.locator("[data-hub-conversation-pencil]")).toBeVisible();
  await page.locator("[data-hub-chat] button[aria-label='Attach files']").click();
  await expect(page.locator("[data-attach-menu]")).toContainText("Photo or image");
  await expect(page.locator("[data-hub-new-conversation-screen]")).toContainText("Click the pencil to name it.");
  await expect(page.locator("[data-hub-conversation-draft-word]")).toHaveText("Draft");
  await page.screenshot({ path: `${SHOTS}/b8-new-conversation.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-hub-conversation]")).toHaveCount(0);
});

test("G4: each Mono's role is a small second line under its name on the rail, at any width, and in the header and tooltip; a Lead's reads Runs the coding team", async ({ page }) => {
  await open(page);
  await showAllMonos(page);
  const rail = page.locator("[data-mono-rail]").first();
  const ada = rail.locator('button[aria-label^="Ada"]').first();
  await expect(ada).toHaveAttribute("title", /^Ada\nKeeps the week moving/);
  // Every Lead reads "Runs the coding team" (its name already says which project), uncut, the Hub's too.
  for (const p of ["EXO", "Hivra", "Nibbii", "MonoCode Hub"]) {
    const role = rail.locator(`button[aria-label^="${p} lead"] [data-mono-role]`);
    await expect(role).toHaveText("Runs the coding team");
    expect(await role.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await ada.click();
  await expect(page.locator("[data-mono-title] [data-mono-role-edit]")).toHaveText("Keeps the week moving");
  await page.locator("[data-mono-title] [data-mono-role-edit]").click();
  await page.locator("[data-mono-role-input]").fill("Keeps the week moving everywhere");
  await page.locator("[data-mono-role-input]").press("Enter");
  await expect(page.locator("[data-mono-title] [data-mono-role-edit]")).toHaveText("Keeps the week moving everywhere");
  await expect(ada).toHaveAttribute("title", /^Ada\nKeeps the week moving everywhere/);
  // At the default width every role shows on its own line under the name; the name keeps the first row.
  for (const [name, role] of [["Ada", "Keeps the week moving everywhere"], ["ed", "Checks what was said"], ["Cam", "One owner per job"]]) {
    const row = rail.locator(`button[aria-label^="${name}"]`).first();
    await expect(row.locator("[data-mono-role]")).toBeVisible();
    await expect(row.locator("[data-mono-role]")).toHaveText(role);
    const [n, r] = [await row.locator("[data-mono-primary-name]").boundingBox(), await row.locator("[data-mono-role]").boundingBox()];
    expect(r!.y).toBeGreaterThanOrEqual(n!.y + n!.height - 2);
  }
  const heights = await rail.locator("button[aria-label][title]").evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.closest(".reorder-item")?.getBoundingClientRect().height ?? 0)).filter(Boolean))]);
  expect(heights).toEqual([38]); // a name with a role under it is 38px (a name alone stays 32px), every row alike
  await page.mouse.move(700, 450);
  await shot(page, "g4-role-labels");
  // The narrow rail: the role is still there, the name still has its whole first row.
  await page.evaluate(() => {
    const list = document.querySelector("[data-mono-rail]") as HTMLElement;
    let el: HTMLElement | null = list;
    while (el && el.getBoundingClientRect().left > 80) el = el.parentElement;
    (list.closest("aside") ?? list).style.width = "160px";
    list.style.width = "160px";
  });
  await expect(ada.locator("[data-mono-role]")).toBeVisible();
  await expect(rail.locator('button[aria-label^="Cam"] [data-mono-role]')).toBeVisible();
  await expect(ada).toHaveAttribute("title", /\nKeeps the week moving everywhere/);
  const pm = rail.locator('button[aria-label^="Bo"] [data-mono-primary-name]').first();
  const box = await pm.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.scroll).toBeLessThanOrEqual(box.client); // the name is not cut
  const railBox = await rail.boundingBox();
  await page.screenshot({ path: `${SHOTS}/g4-narrow-rail.png`, clip: { x: 0, y: 0, width: Math.ceil((railBox?.x ?? 0) + 200), height: 420 } });
});

test("G4 tiles: creatures by default (robots for the team, Ada keeps the picked green crab; EXO invader, Hivra an orange dino not the ghost, Nibbii amber robot, Hub cat); letters are a choice, shown as typed", async ({ page }) => {
  await open(page);
  await showAllMonos(page);
  const rail = page.locator("[data-mono-rail]").first();
  const tile = (name: string) => rail.locator(`button[aria-label^="${name},"] svg.pixel-mascot`).first();
  // Creatures by default on every rail tile: no tile is letters until Ash picks them.
  expect(await rail.locator("button[aria-label][title] svg.pixel-mascot").count()).toBeGreaterThan(7);
  expect(await rail.locator("button[aria-label][title] svg text").count()).toBe(0);
  const fills = (name: string) => tile(name).evaluate((svg) => [...new Set([...svg.querySelectorAll("rect")].map((r) => r.getAttribute("fill")))].join(" "));
  // The robots are one drawing; the grey built-ins share a colour, the amber Nibbii lead has its own.
  const robot = await tile("Bo").innerHTML();
  expect(await tile("ed").innerHTML()).toBe(robot);
  expect(await tile("Cam").innerHTML()).toBe(robot);
  expect(await fills("Nibbii lead")).not.toBe(await fills("Bo"));
  // Ada and the Leads all look different (Ada keeps the picked green crab).
  const faces = await Promise.all(["Ada", "EXO lead", "Hivra lead", "Nibbii lead", "MonoCode Hub lead"].map((n) => tile(n).innerHTML()));
  expect(new Set(faces).size).toBe(5);
  // Each status dot sits just off its tile: it touches none of the creature's pixels and stays inside its row.
  const clear = await dotsClear(rail);
  expect(clear.length).toBeGreaterThan(7);
  expect(new Set(clear)).toEqual(new Set([true]));
  const looks = await page.evaluate(() => Object.fromEntries((JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { id: string; mascot: string; color: string }[]).map((m) => [m.id, `${m.mascot} ${m.color}`])));
  expect(looks).toMatchObject({
    ada: "crab hsl(142 55% 50%)",
    bo: "robot hsl(210 8% 58%)",
    ed: "robot hsl(210 8% 58%)",
    cam: "robot hsl(210 8% 58%)",
    "vg-game-lead": "invader hsl(211 92% 62%)",
    "hivra-lead": "dino hsl(12 80% 58%)",
    "nibbii-lead": "robot hsl(45 90% 55%)",
    "hub-lead": "cat hsl(142 55% 50%)",
  });
  const cam = rail.locator('button[aria-label^="Cam"]').first();
  await cam.click();
  await page.getByRole("button", { name: "Cam settings" }).click();
  await page.getByRole("button", { name: "Change mascot and color" }).click();
  const look = page.getByRole("dialog", { name: "Mascot and color" });
  await expect(look).toBeVisible();
  expect(await look.locator("button svg").count()).toBeGreaterThan(5);
  await look.locator("[data-mono-tile-letters]").fill("Ca");
  await look.locator("[data-mono-tile-letters]").press("Enter");
  await expect(cam.locator("svg text").first()).toHaveText("Ca");
  await shot(page, "g4-tile-letters");
});

test("G4 tiles: the Hivra lead appears once, and its tile stays inside its row at 38px and 32px, even mid-bob", async ({ page }) => {
  await open(page);
  await showAllMonos(page);
  const rail = page.locator("[data-mono-rail]").first();
  await expect(rail.locator('button[aria-label^="Hivra lead,"]')).toHaveCount(1);
  const fits = () =>
    rail.locator('button[aria-label^="Hivra lead,"]').first().evaluate((button) => {
      const row = button.closest(".reorder-item") as HTMLElement;
      const r = row.getBoundingClientRect();
      const prev = (row.previousElementSibling as HTMLElement | null)?.getBoundingClientRect();
      const next = (row.nextElementSibling as HTMLElement | null)?.getBoundingClientRect();
      const svg = button.querySelector("svg.pixel-mascot")!;
      const art = svg.querySelector("g") as SVGGElement;
      const box = () => {
        const rects = [...svg.querySelectorAll("rect")].map((x) => x.getBoundingClientRect()).filter((b) => b.width && b.height);
        return { top: Math.min(...rects.map((b) => b.top)), bottom: Math.max(...rects.map((b) => b.bottom)) };
      };
      const at = box();
      art.style.transform = "translateY(-0.75px)"; // the top of the bob
      const up = box();
      art.style.transform = "";
      const inside = (b: { top: number; bottom: number }) => b.top >= r.top && b.bottom <= r.bottom && (!prev || b.top >= prev.bottom - 0.01) && (!next || b.bottom <= next.top + 0.01);
      return { height: Math.round(r.height), rest: inside(at), bob: inside(up) };
    });
  expect(await fits()).toEqual({ height: 38, rest: true, bob: true });
  await rail.locator('button[aria-label^="Hivra lead,"]').first().evaluate((b) => ((b.closest(".reorder-item") as HTMLElement).style.height = "32px"));
  expect(await fits()).toEqual({ height: 32, rest: true, bob: true });
});

test("Reduced motion stops the bob and the blink", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await page.locator("[data-mono-rail]").first().locator('button[aria-label^="Ada"]').first().click();
  const moving = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".pixel-mascot .pixel-bob, .pixel-mascot .pixel-eyes-open, .pixel-mascot .pixel-eyes-closed, .pixel-mascot .pixel-hop")].map((el) => getComputedStyle(el).animationName),
    );
  await expect.poll(async () => (await moving()).length).toBeGreaterThan(0);
  expect(new Set(await moving())).toEqual(new Set(["none"]));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect((await moving()).some((name) => name !== "none")).toBe(true);
});

test("C6: a Page's calendar block is react-day-picker on the theme's tokens", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^Pages/ }).first().click();
  // WP-01: the list (ready-made pages are there from the start) with its New page button, or the ask box when
  // there are no pages yet. Wait for one of them instead of checking before the view has rendered.
  await expect(page.locator("[data-pages-list], [data-pages-new]").first()).toBeVisible();
  if (await page.locator("[data-pages-list]").count()) await page.locator("[data-pages-new-button]").first().click();
  // WP-04 moved building a page to the Mono's chat (BUILD_MOVED); the app's dev keyword stub stands in for that
  // build here, as in agents-page, so the preview it draws is what this checks.
  await page.evaluate(() => localStorage.setItem("monocode:pages-dev-stub", "1"));
  await page.getByLabel("Describe the page").fill("plan my week, with a calendar");
  await page.getByLabel("Send to a Mono").click();
  const calendar = page.locator("[data-block-calendar]").first();
  await expect(calendar).toBeVisible({ timeout: 30_000 });
  await expect(calendar.locator("th")).toHaveText(["M", "T", "W", "T", "F", "S", "S"]);
  // The "Sample page" note came from the Ash OS stub WP-04 retired; the dev stub's preview says it is a preview instead.
  await expect(page.locator("[data-pages-preview-note]")).toContainText("This is a preview.");
  await expect(page.getByText(/No real Mono ran/)).toHaveCount(0);
  await calendar.scrollIntoViewIfNeeded();
  await page.mouse.move(5, 450);
  await shot(page, "c6-calendar-block");
});

test("G4 dots in every state: working (mid-hop, grey) and idle, the dot touches neither the creature nor the name", async ({ page }) => {
  await seedExampleRoster(page);
  await page.addInitScript(() => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
  });
  await openLocalHub(page, "&fakeClaude");
  const rail = page.locator("[data-mono-rail]").first();
  await expect(rail).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => undefined);
  await showAllMonos(page);
  const hold = () => page.evaluate(() => (window as unknown as { __fakeClaude: { next: string[] } }).__fakeClaude.next.push("hold"));
  const status = (name: string) => rail.locator("[data-mono-status]").filter({ has: page.locator(`button[aria-label^="${name},"]`) }).first();
  // Two turns held open: Ada's and the EXO lead's.
  for (const name of ["Ada", "EXO lead"]) {
    await rail.locator(`button[aria-label^="${name},"]`).first().click();
    await hold();
    const field = page.getByLabel(`Message ${name}`);
    await field.fill("Example: start on this week's plan");
    await field.press("Enter");
    await expect(status(name)).toHaveAttribute("data-mono-status", "working", { timeout: 15_000 });
  }
  // Leave the chats for a hub view that keeps the whole roster (G1 scopes the rail to a project; Autopilot is none).
  await showAllMonos(page);
  await expect(status("EXO lead").locator(".pixel-hop")).toHaveCount(1);
  // A working dot is grey (no inline colour), not the Mono's own colour.
  const working = status("EXO lead").locator('[data-mono-dot="working"]');
  await expect(working).toHaveClass(/bg-content\/60/);
  expect(await working.evaluate((d) => (d as HTMLElement).style.backgroundColor)).toBe("");
  // Sampled through the hop (the working creature moves), every dot stays clear of creature and text.
  // The pointer still rests on the row clicked last, and a hovered row's title is held back for the app's own
  // tooltip, which would drop that row from the sample below. Park it off the rail first.
  await page.mouse.move(1400, 880);
  for (let frame = 0; frame < 12; frame += 1) {
    const clear = await dotsClear(rail);
    expect(clear.length).toBeGreaterThan(7);
    expect(new Set(clear)).toEqual(new Set([true]));
    await page.waitForTimeout(110);
  }
  const shown = await rail.locator("[data-mono-dot]").evaluateAll((dots) => dots.map((d) => d.getAttribute("data-mono-dot")));
  expect(shown).toEqual(expect.arrayContaining(["working", "idle"]));
  // The proof, unhovered: the pointer is parked off the rail.
  await page.mouse.move(1400, 880);
  await page.waitForTimeout(400);
  const box = (await rail.boundingBox())!;
  await page.screenshot({ path: `${SHOTS}/pm-ui-4-rail-dots.png`, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 340) } });
  await page.evaluate(() => (window as unknown as { __fakeClaude: { release(): void } }).__fakeClaude.release());
});
