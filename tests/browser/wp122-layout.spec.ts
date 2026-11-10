import { expect, test, type Page } from "@playwright/test";
import type { Block } from "../../src/features/sessions/model/session";

type Fixture = Window & { setReplayBlocks(blocks: Block[], busy: boolean): void };

// The real SessionPane, AgentTranscript and Composer (tests/browser/session-pane.tsx; only native IPC is fake) with a
// thread that started several native subagents. The subagent list must never push the newest message under the
// composer, however many children there are.
test.use({ viewport: { width: 1000, height: 700 } });

const LAST = "Every subagent is done, and the auth module is clean.";

function thread(children: number): Block[] {
  const agents = Array.from({ length: children }, (_, i): Block => {
    const state = i % 4 === 3 ? "failed" : i % 4 === 2 ? "in_progress" : "completed";
    return {
      id: `agent-${i}`,
      role: "tool",
      text: `Check module ${i}`,
      tool: {
        callId: `toolu_${i}`,
        title: `Check module ${i}`,
        kind: "agent",
        status: state,
        detail: state === "completed" ? `Module ${i} is fine.` : state === "failed" ? "The model name was unknown." : undefined,
      },
      agentRun: { name: `Check module ${i}`, agentType: "explore", model: "claude-haiku-5", steps: [] },
    };
  });
  return [
    { id: "u1", role: "user", text: "Check every module with a subagent each.", startedAt: Date.now() },
    ...agents,
    { id: "a1", role: "assistant", text: LAST },
  ];
}

async function open(page: Page, children: number) {
  await page.goto("/tests/browser/session-pane.html");
  await page.waitForFunction(() => typeof (window as Fixture).setReplayBlocks === "function");
  await page.evaluate(
    ({ blocks }) => {
      document.getElementById("root")!.style.width = "1000px";
      (window as Fixture).setReplayBlocks(blocks, false);
    },
    { blocks: thread(children) },
  );
  await expect(page.locator('[data-chat-message="a1"]')).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
}

for (const children of [3, 6, 12]) {
  test(`${children} native subagents leave the newest message above the composer`, async ({ page }) => {
    await open(page, children);
    const scroller = page.locator(".agent-transcript");
    await expect(page.locator("[data-lineage]")).toHaveCount(1);
    await expect.poll(() =>
      scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    ).toBeLessThanOrEqual(1);
    const last = page.locator('[data-chat-message="a1"]');
    const composer = page.locator("[data-session-composer]");
    await expect(last).toBeVisible();
    const [lastBox, composerBox, scrollBox] = await Promise.all([
      last.boundingBox(),
      composer.boundingBox(),
      scroller.boundingBox(),
    ]);
    expect(lastBox && composerBox && scrollBox).toBeTruthy();
    // The newest line sits fully inside the transcript's own box, which ends where the composer begins.
    expect(lastBox!.y).toBeGreaterThanOrEqual(scrollBox!.y);
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
    expect(scrollBox!.y + scrollBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
    // And the list never grows past a share of the pane, however many children there are.
    const list = await page.locator("[data-lineage]").boundingBox();
    expect(list!.height).toBeLessThanOrEqual(scrollBox!.height * 0.4);
    // The list sits inside the transcript's scroll content, so it scrolls with the thread instead of taking height from it.
    await expect(scroller.locator("[data-lineage]")).toHaveCount(1);
  });
}

test("opening the list of 12 stops at a share of the pane, scrolls inside, and leaves the newest message reachable", async ({ page }) => {
  await open(page, 12);
  const scroller = page.locator(".agent-transcript");
  await page.getByRole("button", { name: /Subagents/ }).click();
  const rows = page.locator("[data-lineage-rows]");
  await expect(rows.locator("[data-lineage-child]")).toHaveCount(12);
  const [rowsBox, scrollBox] = await Promise.all([rows.boundingBox(), scroller.boundingBox()]);
  expect(rowsBox!.height).toBeLessThanOrEqual(scrollBox!.height * 0.4);
  // Twelve rows do not fit in that box, so it scrolls inside itself.
  expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // Opening it did not move the thread's own box, and the newest message is one scroll to the end away.
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  const last = page.locator('[data-chat-message="a1"]');
  const [lastBox, composerBox] = await Promise.all([last.boundingBox(), page.locator("[data-session-composer]").boundingBox()]);
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
  expect(lastBox!.y).toBeGreaterThanOrEqual(scrollBox!.y);
  await page.screenshot({ path: "test-results/wp122-layout-open.png" });
});
