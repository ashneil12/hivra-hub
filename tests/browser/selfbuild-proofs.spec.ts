import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
// @ts-expect-error plain .mjs helper
import { startStub } from "../../scripts/hub-stub-server.mjs";

// Self-build proofs (ash-day steps 13-15) in the real app in a browser: hub-dev.html reading the stub Ash OS, the Mono
// on the stand-in Claude CLI. The tools' app side runs for real (selfBuildProof.ts); only git is stood in for.
// A browser preview only, not Ash's Mac.
//   PM_PROOF_SPEC=selfbuild-proofs.spec.ts PM_PROOF_DIR=proofs npx playwright test -c tests/browser/pm-screens.config.ts

const SHOTS = process.env.PM_PROOF_DIR ?? "test-results/selfbuild";
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub({ jobs: true, dev: true });
});
test.afterAll(async () => stub?.close());
test.use({ viewport: { width: 1440, height: 900 } });

const dev = <T,>(page: Page, code: string, arg?: unknown) =>
  page.evaluate(([c, a]) => new Function("sb", "arg", `return (${c})(sb, arg)`)((window as unknown as { __devSelfBuild: unknown }).__devSelfBuild, a) as T, [code, arg] as const);
const ME = { monoId: "chief-of-staff", name: "Chief of Staff", projects: [] };

async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }));
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:sonnet-5" }));
  });
  await page.goto(`/hub-dev.html?stub=${encodeURIComponent(stub.url)}&fakeClaude`);
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({ timeout: 60_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => undefined);
  await page.waitForFunction(() => "__devSelfBuild" in window);
}

test("13: the drafted Mono is shown to Ash before his yes, and nothing is made yet", async ({ page }) => {
  await open(page);
  const draft = await dev<{ draftId: string; plan: { name: string; role: string; soul: string; skills: string[] } }>(
    page,
    "(sb, me) => sb.draftMono({ name: 'Postie', role: 'X posts for Hivra', who: \"I'm Postie. I watch Hivra's shipped work and turn the good bits into short X posts, and I flag anything that shouldn't be public yet.\", skills: ['x-threads', 'hivra-changelog'] }, me)",
    ME,
  );
  const card = [`Here's the one Mono I'd make:`, ``, `**${draft.plan.name}** · ${draft.plan.role}`, ``, `> ${draft.plan.soul}`, ``, `Skills: ${draft.plan.skills.join(", ")}`, ``, `Say yes and I'll make it.`].join("\n");
  const rail = page.locator("[data-mono-rail]").first();
  await rail.locator('button[aria-label^="Chief of Staff"]').first().click();
  await page.evaluate((w) => (window as unknown as { __fakeClaude: { next: string[] } }).__fakeClaude.next.push(w), `say:${card}`);
  const composer = page.getByLabel("Message Chief of Staff");
  await composer.fill("can u make me a mono that does x posts for hivra");
  await composer.press("Enter");
  await expect(page.getByText("Say yes and I'll make it.")).toBeVisible({ timeout: 20_000 });
  await expect(rail.locator('button[aria-label^="Postie"]')).toHaveCount(0);
  await shot(page, "13-draft-mono-before-yes");
});

test("14: a Page built in chat shows as a preview with Keep and Throw away", async ({ page }) => {
  await open(page);
  const spec = {
    kind: "blocks",
    title: "Hivra this week",
    blocks: [
      { kind: "status", title: "This week", state: "warn", line: "5 shipped, 2 stuck", detail: "Mon 19 – Wed 21 Oct" },
      { kind: "list", title: "Shipped and stuck", rows: [
        { text: "Waitlist emails send in batches", state: "ok", label: "Shipped" },
        { text: "Sign-up page copy", state: "ok", label: "Shipped" },
        { text: "Pricing page A/B", state: "ok", label: "Shipped" },
        { text: "Email sender login", state: "bad", label: "Stuck" },
        { text: "Stripe webhook retries", state: "bad", label: "Stuck" },
      ] },
      { kind: "barlist", title: "Shipped per day", rows: [{ label: "Mon", value: 2 }, { label: "Tue", value: 2 }, { label: "Wed", value: 1 }] },
    ],
  };
  const made = await dev<{ previewId: string }>(page, "(sb, spec) => sb.previewFromChat({ project: 'hivra', spec, request: 'a page for hivra: whats shipped this week n whats stuck' }, { monoId: 'hivra-lead', name: 'Hivra lead' })", spec);
  await expect(page.locator("[data-change-see]")).toBeVisible();
  await page.locator("[data-change-see]").click();
  await expect(page.getByText("Hivra this week").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Keep" }).first()).toBeVisible();
  expect(made.previewId).toBeTruthy();
  await shot(page, "14-page-preview");
});

test("15: a hub change shows Now | Preview with Apply and Discard; after Apply, undoing the colour leaves the button", async ({ page }) => {
  await open(page);
  await dev(page, `async (sb) => { const { changeId } = await sb.startHubChange("can u move the new chat button to the top n make the accent a bit more purple", "New chat button at the top, accent more purple", "Chief of Staff"); return sb.readyHubChange(changeId, "Chief of Staff"); }`);
  const offer = page.locator("[data-change-offer]");
  await expect(offer).toBeVisible();
  await offer.locator("[data-change-preview]").click();
  await expect(offer).toHaveAttribute("data-previewing", "1");
  await expect(offer.locator("[data-change-apply]")).toBeVisible();
  await expect(offer.locator("[data-change-discard]")).toBeVisible();
  await shot(page, "15-now-preview-apply-discard");

  await offer.locator("[data-change-apply]").click();
  await expect(offer).toHaveCount(0);
  await page.getByRole("button", { name: /^Settings/ }).first().click();
  await page.getByRole("button", { name: /^Changes/ }).first().click();
  await page.getByRole("button", { name: "Bot changes" }).click();
  const colour = page.locator("[data-hub-bot-change]", { has: page.getByText("Accent is a bit more purple", { exact: false }) }).first();
  const button = page.locator("[data-hub-bot-change]", { has: page.getByText("New chat button is at the top", { exact: false }) }).first();
  await expect(colour).toBeVisible();
  await colour.locator("[data-hub-bot-change-undo]").click();
  await expect(colour.locator("[data-hub-bot-change-undone]")).toBeVisible();
  await expect(button.locator("[data-hub-bot-change-undone]")).toHaveCount(0);
  await shot(page, "15-bot-changes-after-undo");
});
