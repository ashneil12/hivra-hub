import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { seedExampleRoster } from "./exampleRoster";
import { openLocalHub } from "./localHub";

// Self-build proofs (ash-day steps 13-15) in the real app in a browser: hub-dev.html reading the app's own local store, the Mono
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

test.use({ viewport: { width: 1440, height: 900 } });

const dev = <T>(page: Page, code: string, arg?: unknown) =>
  page.evaluate(
    ([c, a]) =>
      new Function("sb", "arg", `return (${c})(sb, arg)`)(
        (window as unknown as { __devSelfBuild: unknown }).__devSelfBuild,
        a,
      ) as T,
    [code, arg] as const,
  );
const ME = { monoId: "ada", name: "Ada", projects: [] };

async function open(page: Page) {
  await seedExampleRoster(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      "monocode.lastModel",
      JSON.stringify({ harness: "claude", model: "claude:sonnet-5" }),
    );
    localStorage.setItem(
      "monocode.defaultModels",
      JSON.stringify({ claude: "claude:sonnet-5" }),
    );
  });
  await openLocalHub(page, "&fakeClaude");
  await expect(page.locator("[data-mono-rail]").first()).toBeVisible({
    timeout: 60_000,
  });
  const notNow = page.getByRole("button", { name: "Not now" });
  await notNow.waitFor({ timeout: 4000 }).then(
    () => notNow.click(),
    () => undefined,
  );
  await page.waitForFunction(() => "__devSelfBuild" in window);
}

test("13: Dr Eggbot style: the Mono asks first, Ash answers, then it shows the one Mono it drafted; nothing is made yet", async ({
  page,
}) => {
  await open(page);
  const rail = page.locator("[data-mono-rail]").first();
  await rail.locator('button[aria-label^="Ada"]').first().click();
  const say = (text: string) =>
    page.evaluate(
      (w) =>
        (
          window as unknown as { __fakeClaude: { next: string[] } }
        ).__fakeClaude.next.push(w),
      `say:${text}`,
    );
  const composer = page.getByLabel("Message Ada");
  // 1. Ash asks; the Mono asks him one real question back and ends its turn.
  await say(
    "Happy to. Two quick questions first: should it post on its own, or draft each post for your OK? And who does it answer to?",
  );
  await composer.fill("can u make me a mono that does x posts for hivra");
  await composer.press("Enter");
  await expect(page.getByText("who does it answer to?")).toBeVisible({
    timeout: 20_000,
  });
  // 2. Ash answers; only now does the Mono draft (mono_create), with skills that are really installed on his Mac.
  const draft = await dev<{
    draftId: string;
    plan: {
      name: string;
      role: string;
      soul: string;
      watchFor: string;
      skills: string[];
    };
  }>(
    page,
    `(sb, me) => sb.draftMono({ name: 'Postie', role: 'X posts for Hivra', who: "I'm Postie. I turn Hivra's shipped work into short X posts and draft each one for Ash's OK. I answer to Hivra lead.", watchFor: "Good bits worth a thread, and anything that shouldn't be public yet.", skills: ['ash-copywriting', 'human-writing', 'hivra-release'] }, me, ['ash-copywriting', 'human-writing', 'hivra-release', 'hivra-seo', 'humanizer'])`,
    ME,
  );
  await say(
    `Here's the one Mono I'd make: **${draft.plan.name}**, ${draft.plan.role}. It's on the card at the top. Say yes and I'll make it.`,
  );
  await composer.fill("draft for my ok. it answers to hivra lead");
  await composer.press("Enter");
  await expect(page.getByText("Say yes and I'll make it.")).toBeVisible({
    timeout: 20_000,
  });
  // The draft card: the creature and colour it will get, drawn with monoAvatar like the sidebar tiles.
  const card = page.locator(`[data-mono-draft="${draft.draftId}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator("[data-mono-draft-name]")).toHaveText("Postie");
  await expect(card.locator("[data-mono-draft-role]")).toHaveText(
    "X posts for Hivra",
  );
  await expect(card.getByText(draft.plan.watchFor)).toBeVisible();
  // It speaks to Ash as "you" (the saved soul keeps "Ash's OK").
  await expect(card.getByText("draft each one for your OK")).toBeVisible();
  await expect(card.getByText("Ash's OK")).toHaveCount(0);
  // A draft isn't running yet: no status dot on its tile.
  await expect(card.locator("[data-mono-dot]")).toHaveCount(0);
  await expect(
    card.locator("svg, canvas, img, [data-mono-letter]").first(),
  ).toBeVisible();
  await expect(rail.locator('button[aria-label^="Postie"]')).toHaveCount(0);
  // claude:sonnet-5 is named "Claude Sonnet 5" in the model catalog (models.ts). The model line shows that name with the "Claude " prefix removed.
  await expect(page.locator("text=/Sonnet 5/ >> visible=true").first()).toBeVisible();
  await card.screenshot({ path: `${SHOTS}/13-draft-mono-card.png` });
  await shot(page, "13-draft-mono-before-yes");
});

test("14: a Page built in chat shows as a preview with Apply and Discard, real data or Nothing here yet", async ({
  page,
}) => {
  await open(page);
  const spec = {
    kind: "blocks",
    title: "Hivra this week",
    blocks: [
      {
        kind: "status",
        title: "This week",
        state: "warn",
        line: "5 shipped, 2 stuck",
        detail: "Mon 19 – Wed 21 Oct",
      },
      {
        kind: "list",
        title: "Shipped and stuck",
        rows: [
          {
            text: "Waitlist emails send in batches",
            state: "ok",
            label: "Shipped",
          },
          { text: "Sign-up page copy", state: "ok", label: "Shipped" },
          { text: "Pricing page A/B", state: "ok", label: "Shipped" },
          { text: "Email sender login", state: "bad", label: "Stuck" },
          { text: "Stripe webhook retries", state: "bad", label: "Stuck" },
        ],
      },
      {
        kind: "barlist",
        title: "Shipped per day",
        rows: [
          { label: "Mon", value: 2 },
          { label: "Tue", value: 2 },
          { label: "Wed", value: 1 },
        ],
      },
      // Nothing real to show yet: the block goes in empty and says so.
      { kind: "chart", title: "Sign-ups per day", bars: [] },
    ],
  };
  const made = await dev<{ previewId: string }>(
    page,
    "(sb, spec) => sb.previewFromChat({ project: 'hivra', spec, request: 'a page for hivra: whats shipped this week n whats stuck' }, { monoId: 'hivra-lead', name: 'Hivra lead' })",
    spec,
  );
  await expect(page.locator("[data-change-see]")).toBeVisible();
  await page.locator("[data-change-see]").click();
  await expect(page.getByText("Hivra this week").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Apply" }).first()).toBeVisible();
  await expect(page.locator("[data-pages-discard]")).toHaveText("Discard");
  await expect(page.locator("[data-pages-preview-note]")).toContainText("Undo later in Bot changes.");
  await expect(page.locator("[data-block-empty]")).toHaveText("Nothing here yet");
  // Ash is on the page: the bar doesn't offer See it again.
  await expect(page.locator("[data-change-see]")).toHaveCount(0);
  expect(made.previewId).toBeTruthy();
  await shot(page, "14-page-preview");
});

test("15: a hub change shows Now | Preview with Apply and Discard; after Apply, undoing the colour leaves the button", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: /^EXO/ }).first().click();
  await page.locator('[data-hub-item="leadership-team"]').click();
  await expect(page.locator("[data-hub-new-conversation]")).toBeVisible();
  const buttonTop = async () =>
    (await page.locator("[data-hub-new-conversation]").boundingBox())!.y;
  const before = await buttonTop();
  await dev(
    page,
    `async (sb) => { const { changeId } = await sb.startHubChange("can u move the new chat button to the top n make the accent a bit more purple", "New chat button at the top, accent more purple", "Ada"); return sb.readyHubChange(changeId, "Ada"); }`,
  );
  const offer = page.locator("[data-change-offer]");
  await expect(offer).toBeVisible();
  await offer.locator("[data-change-preview]").click();
  await expect(offer).toHaveAttribute("data-previewing", "1");
  // Preview shows the change for real: the button sits higher and the accent is purple.
  await expect.poll(buttonTop).toBeLessThan(before);
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--scheme-accent")
        .trim(),
    ),
  ).toBe("hsl(268 85% 72%)");
  // The purple is easy to see: the selected row and the send button carry it.
  const purple = /rgba?\((1[4-9]\d), ([6-9]\d|1[0-3]\d), (2[2-5]\d)/;
  await expect
    .poll(() => page.locator('[data-hub-item="leadership-team"]').evaluate((el) => getComputedStyle(el).backgroundColor))
    .toMatch(purple);
  await expect
    .poll(() => page.locator('button[aria-label="Send"]').first().evaluate((el) => getComputedStyle(el).backgroundColor))
    .toMatch(purple);
  await expect(offer.locator("[data-change-apply]")).toBeVisible();
  await expect(offer.locator("[data-change-discard]")).toBeVisible();
  await shot(page, "15-now-preview-apply-discard");

  await offer.locator("[data-change-apply]").click();
  await expect(offer).toHaveCount(0);
  await page
    .getByRole("button", { name: /^Settings/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: /^Changes/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Bot changes" }).click();
  const colour = page
    .locator("[data-hub-bot-change]", {
      has: page.getByText("Accent is a bit more purple", { exact: false }),
    })
    .first();
  const button = page
    .locator("[data-hub-bot-change]", {
      has: page.getByText("New chat button is at the top", { exact: false }),
    })
    .first();
  await expect(colour).toBeVisible();
  await colour.locator("[data-hub-bot-change-undo]").click();
  await expect(colour.locator("[data-hub-bot-change-undone]")).toBeVisible();
  await expect(button.locator("[data-hub-bot-change-undone]")).toHaveCount(0);
  // Only the colour went back.
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--scheme-accent")
        .trim(),
    ),
  ).not.toBe("hsl(268 85% 72%)");
  await shot(page, "15-bot-changes-after-undo");
});
