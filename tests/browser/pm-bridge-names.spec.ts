import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Rounds 15 and 16: with Claude Code on the Grok bridge, no surface names a Claude model or shows Claude's mark (the
// chat toolbar's model picker and its menu, the chat card and its hover preview, the tab, the turn header), and the
// usage chip is gone (its numbers are the Claude plan's). They all read claudeGrokBridge.ts. Also, rail names and the turn header line
// keep at least 4.5:1 in every state. Example data only. A browser preview, not Ash's Mac.
const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/pm-bridge-names";
type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

const FOLDER = "/Users/example/Projects/vg-game";
const CHAT = "9d3e7b10-readme";
const CLAUDE_MODEL = /Sonnet|Opus|Haiku|Claude(?! Code)/;

const seed = (page: Page, bridge: boolean, inset = false) =>
  page.addInitScript(
    ({ chat, folder, at, bridge, inset }) => {
      if (inset) localStorage.setItem("monocode.insetLayout", "1");
      localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
      localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
      if (bridge) localStorage.setItem("monocode.providerBinaryPaths.v1", JSON.stringify({ claude: "/Users/ash/.local/bin/claude-grok" }));
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(
        "monocode:dev-sessions",
        JSON.stringify([
          {
            id: chat, cwd: folder, harness: "claude", model: "claude:sonnet-5", runtimeMode: "supervised", title: "Example: Tidy the readme",
            createdAt: at - 3_600_000, updatedAt: at - 60_000,
            blocks: [
              { id: "b1", role: "user", text: "Example: tidy the readme", turnModel: { harness: "claude", id: "claude:sonnet-5", name: "Claude Sonnet 5" } },
              { id: "b2", role: "assistant", text: "Example: Done, the readme is shorter now." },
            ],
          },
        ]),
      );
    },
    { chat: CHAT, folder: FOLDER, at: Date.now(), bridge, inset },
  );

const closeOffer = async (page: Page) => {
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
};

/** Every Claude model name (text, title or aria-label) and every Claude logo inside these elements. */
const claudeTraces = (page: Page, selector: string) =>
  page.evaluate(
    ({ selector, source }) => {
      const re = new RegExp(source);
      const found: string[] = [];
      for (const root of document.querySelectorAll(selector)) {
        const text = (root as HTMLElement).innerText ?? "";
        if (re.test(text)) found.push(`text: ${text.match(re)![0]} in ${selector}`);
        for (const el of [root, ...root.querySelectorAll("*")]) {
          for (const attr of ["title", "aria-label"]) {
            const v = el.getAttribute(attr);
            if (v && re.test(v)) found.push(`${attr}: ${v}`);
          }
          // The Claude mark (assets/providers/claude.svg), as a file URL in dev or inlined as data.
          if (el instanceof HTMLImageElement && /claude|clip0_2480_92/i.test(el.src)) found.push(`Claude logo in ${selector}`);
        }
      }
      return found;
    },
    { selector, source: CLAUDE_MODEL.source },
  );

const shotOf = async (page: Page, name: string, selector: string, pad = 8) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const box = (await page.locator(selector).first().boundingBox())!;
  await page.screenshot({
    path: `${SHOTS}/${name}.png`,
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad },
  });
};

async function openChat(page: Page, bridge: boolean, inset = false) {
  await seed(page, bridge, inset);
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}&fakeClaude`);
  await expect(page.getByRole("button", { name: /^EXO/ }).first()).toBeVisible({ timeout: 60_000 });
  await closeOffer(page);
  await page.getByRole("button", { name: /^EXO/ }).first().click();
  await page.locator(`[data-session-card="${CHAT}"]`).click();
  await expect(page.locator("[data-composer-box]:visible textarea").first()).toBeVisible({ timeout: 15_000 });
  await closeOffer(page);
}


const park = async (page: Page) => {
  await page.mouse.move(1435, 300);
  await page.waitForTimeout(500);
};
const SURFACES = {
  toolbar: "[data-composer-box]:visible",
  card: `[data-session-card="${CHAT}"]`,
  tabs: "[data-surface-tabs], [role=tablist]",
  usage: "[data-usage-footer], .inset-footer, .border-t.border-stroke.px-3",
};

/** The union of two boxes, for a photo of a menu with its open submenu. */
const union = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};
const shotBox = async (page: Page, name: string, box: { x: number; y: number; width: number; height: number }, pad = 8) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } });
};
/** How opaque a panel's own fill is (0 to 1). */
const fillAlpha = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = getComputedStyle(el).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data[3] / 255;
  });

test("on the Grok bridge: no Claude model name or logo anywhere, no usage chip, and the model menu lists only Grok 4.7", async ({ page }) => {
  await openChat(page, true);
  await park(page);
  // The toolbar picker names what runs, with no mark beside it.
  const picker = page.locator("[data-composer-box]:visible button[aria-haspopup]").filter({ hasText: "Grok 4.7" });
  await expect(picker).toHaveCount(1);
  await expect(picker.locator("img")).toHaveCount(0);
  // Nor Grok's own mark (a slashed circle that reads as "disabled"), anywhere.
  await expect(page.locator('svg[viewBox="0 0 35 33"]')).toHaveCount(0);
  // The whole app as rendered: no Claude model text (text, title or label) and no Claude logo anywhere.
  expect(await claudeTraces(page, "body")).toEqual([]);
  // No usage chip, no popover, and no footer chip in its place: those numbers are the Claude plan's.
  await expect(page.getByRole("button", { name: /usage details$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh usage" })).toHaveCount(0);
  // r102 (61ebb49): the chat's mark is a neutral grey chat mark (no Claude starburst, no slashed Grok circle).
  const card = page.locator(SURFACES.card).first();
  await expect(card.locator("[data-model-mark-neutral]")).toHaveCount(1);
  await expect(card.locator("img")).toHaveCount(0);
  await shotOf(page, "pm-16-toolbar-picker", "[data-composer-box]:visible");
  await shotOf(page, "pm-16-chat-card", SURFACES.card);
  await shotOf(page, "pm-16-tab", `button:has-text("Example: Tidy the readme") >> nth=0`, 6);

  // The opened model menu: its Model row reads Grok 4.7 and its list holds only Grok 4.7, already chosen.
  await picker.click();
  const menu = page.getByRole("menu", { name: "Model and settings" });
  await expect(menu).toBeVisible();
  const modelRow = menu.getByRole("menuitem").filter({ hasText: /^Model/ });
  await expect(modelRow).toContainText("Grok 4.7");
  await modelRow.hover();
  const list = page.locator("[data-bridge-model-list]");
  await expect(list).toBeVisible();
  await expect(list.getByRole("menuitemradio")).toHaveText(["Grok 4.7"]);
  await expect(list.getByRole("menuitemradio")).toHaveAttribute("aria-checked", "true");
  expect(await claudeTraces(page, "body")).toEqual([]);
  // Both menus on the more solid panel glass, so the chat behind doesn't read through.
  expect(await fillAlpha(page, '[role="menu"][aria-label="Model and settings"]')).toBeGreaterThanOrEqual(0.85);
  expect(await fillAlpha(page, "[data-bridge-model-list]")).toBeGreaterThanOrEqual(0.85);
  await park(page);
  await shotBox(page, "pm-16-model-menu", union((await menu.boundingBox())!, (await list.boundingBox())!));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // A turn. While it runs its header is the one live status line (Critiquito, 29 Oct), with no Claude name or mark; once
  // it ends the header says Grok 4.7 worked, the whole line one grey, and at least 4.5:1.
  await page.evaluate(() => (window as unknown as { __fakeClaude: { next: string[] } }).__fakeClaude.next.push("hold"));
  const field = page.locator("[data-composer-box]:visible textarea").first();
  await field.fill("Example: and the changelog");
  await field.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: /^(Thinking|Writing)/ }).first()).toBeVisible({ timeout: 15_000 });
  expect(await claudeTraces(page, "body")).toEqual([]);
  await page.evaluate(() => (window as unknown as { __fakeClaude: { release(): void } }).__fakeClaude.release());
  const title = page.getByText(/^Grok 4\.7 worked/).last();
  await expect(title).toBeVisible({ timeout: 15_000 });
  expect(await title.evaluate((el) => [...el.querySelectorAll("*")].length)).toBe(0);
  expect(await title.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
  expect(await contrast(title)).toBeGreaterThanOrEqual(4.5);
  expect(await claudeTraces(page, "body")).toEqual([]);
  await park(page);
  const row = title.locator("xpath=ancestor::*[contains(@class,'items-center')][1]");
  await row.evaluate((el) => el.setAttribute("data-proof-header", ""));
  await shotOf(page, "pm-16-turn-header", "[data-proof-header]", 12);
});

test("on the Grok bridge: the chat card's hover preview names Grok 4.7, no logo, on the more solid glass", async ({ page }) => {
  await openChat(page, true, true);
  await park(page);
  const cards = page.locator(SURFACES.card);
  for (let i = 0; i < (await cards.count()); i += 1) if (await cards.nth(i).isVisible()) await cards.nth(i).hover();
  const preview = page.locator(`[data-session-preview="${CHAT}"]`).first();
  await expect(preview).toBeVisible({ timeout: 5000 });
  await expect(preview).toContainText("Grok 4.7");
  await preview.evaluate((el) => el.setAttribute("data-proof-preview", ""));
  expect(await claudeTraces(page, "[data-proof-preview]")).toEqual([]);
  // The more solid panel glass (a 92% fill with a 24px blur): the screen behind doesn't show through.
  await expect(preview).toHaveClass(/solid-panel-glass/);
  expect(await fillAlpha(page, "[data-proof-preview]")).toBeGreaterThanOrEqual(0.85);
  await page.waitForTimeout(300);
  // A hover surface: it only exists while the card is hovered, so this one photo is taken hovered.
  await shotOf(page, "pm-16-card-preview", "[data-proof-preview]");
});

test("off the bridge nothing changes: Claude Sonnet 5 with Claude's mark, the full model list, the usage chip and its popover", async ({ page }) => {
  await openChat(page, false);
  await park(page);
  const picker = page.locator("[data-composer-box]:visible button[aria-haspopup]").filter({ hasText: "Sonnet 5" });
  await expect(picker).toHaveCount(1);
  await expect(page.locator(SURFACES.card)).toContainText("Sonnet 5");
  const traces = await claudeTraces(page, "body");
  expect(traces.some((t) => t.startsWith("Claude logo"))).toBe(true);
  // The usage chip is still there.
  const chip = page.getByRole("button", { name: /usage details$/ }).first();
  await expect(chip).toHaveAttribute("aria-label", "Claude Code usage details");
  // The full model list, with Claude's models.
  await picker.click();
  const menu = page.getByRole("menu", { name: "Model and settings" });
  await menu.getByRole("menuitem").filter({ hasText: /^Model/ }).hover();
  await expect(page.locator("[data-bridge-model-list]")).toHaveCount(0);
  await expect(page.getByText(/Sonnet|Opus|Haiku/).nth(2)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await park(page);
  // Its popover: the account name whole (no "Default a…"), on the more solid glass.
  await chip.click();
  const pop = page.getByRole("dialog", { name: "Claude Code usage details" });
  await expect(pop).toBeVisible();
  await pop.evaluate((el) => el.setAttribute("data-proof-pop", ""));
  const label = pop.locator("[data-usage-account-label]");
  if (await label.count()) {
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  expect(await fillAlpha(page, "[data-proof-pop]")).toBeGreaterThanOrEqual(0.85);
  await park(page);
  await shotOf(page, "pm-16-usage-popover-off-bridge", "[data-proof-pop]");
});

/** WCAG contrast of an element's text over what is painted under it (its ancestors' backgrounds, composited). */
const contrast = (el: import("@playwright/test").Locator) =>
  el.evaluate((node) => {
    // Any CSS colour (rgb, oklab, color-mix…) to sRGB bytes, by painting one pixel.
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const parse = (c: string) => {
      if (!c || c === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    for (let e: Element | null = node; e; e = e.parentElement) {
      const bg = parse(getComputedStyle(e).backgroundColor);
      if (bg && bg.a > 0) layers.push(bg);
      if (bg && bg.a >= 1) break;
    }
    let base = { r: 0, g: 0, b: 0 };
    if (!layers.length || layers[layers.length - 1].a < 1) {
      const root = parse(getComputedStyle(document.documentElement).backgroundColor);
      base = root && root.a > 0 ? root : { r: 22, g: 22, b: 24 };
    }
    for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) };
    const style = getComputedStyle(node);
    const fg = parse(style.color);
    // Text painted through a gradient (a shimmer) has a transparent colour: that is the 2:1 case, so it fails.
    if (style.backgroundClip === "text" || fg.a === 0) return 1;
    const op = Number(style.opacity) * (node.closest("[class*='opacity-']") ? Number(getComputedStyle(node.closest("[class*='opacity-']")!).opacity) : 1);
    const a = fg.a * op;
    const text = { r: fg.r * a + base.r * (1 - a), g: fg.g * a + base.g * (1 - a), b: fg.b * a + base.b * (1 - a) };
    const lum = (c: { r: number; g: number; b: number }) => {
      const ch = [c.r, c.g, c.b].map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const [hi, lo] = [lum(text), lum(base)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });

test("rail names keep at least 4.5:1 in every state on screen: working, idle, selected and hovered", async ({ page }) => {
  await openChat(page, true);
  const rail = page.locator("[data-mono-rail]").first();
  const hold = () => page.evaluate(() => (window as unknown as { __fakeClaude: { next: string[] } }).__fakeClaude.next.push("hold"));
  for (const name of ["Chief of Staff", "EXO lead"]) {
    await rail.locator(`button[aria-label^="${name},"]`).first().click();
    await hold();
    const field = page.getByLabel(`Message ${name}`);
    await field.fill("Example: start on this week's plan");
    await field.press("Enter");
    await expect(rail.locator("[data-mono-status]").filter({ has: page.locator(`button[aria-label^="${name},"]`) }).first()).toHaveAttribute("data-mono-status", "working", { timeout: 15_000 });
  }
  // Leave the chat for the project's own Today (G1): picking a project item closes the 1:1 cover, then its Inbox.
  await page.locator('[data-hub-item="being-built"]').first().click();
  await page.evaluate(() => (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect({ project: "vg-game", item: "inbox" }));
  await park(page);
  const measure = async () => {
    const names = rail.locator("[data-mono-primary-name], [data-mono-own-name]");
    const out: { state: string; ratio: number }[] = [];
    for (let i = 0; i < (await names.count()); i += 1) {
      const n = names.nth(i);
      if (!(await n.isVisible())) continue;
      const state = (await n.evaluate((el) => el.closest("[data-mono-status]")?.getAttribute("data-mono-status"))) ?? "?";
      out.push({ state, ratio: await contrast(n) });
    }
    return out;
  };
  const shown = await measure();
  expect(shown.map((s) => s.state)).toEqual(expect.arrayContaining(["working", "idle"]));
  for (const s of shown) expect(s.ratio, `${s.state} name`).toBeGreaterThanOrEqual(4.5);
  // Hovered (the row's own wash) still passes.
  await rail.locator('button[aria-label^="EXO lead,"]').first().hover();
  for (const s of await measure()) expect(s.ratio, `${s.state} name, hovered`).toBeGreaterThanOrEqual(4.5);
  await park(page);
  const box = (await rail.boundingBox())!;
  await page.screenshot({ path: `${SHOTS}/pm-15-rail-names.png`, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 340) } });
  await page.evaluate(() => (window as unknown as { __fakeClaude: { release(): void } }).__fakeClaude.release());
});
