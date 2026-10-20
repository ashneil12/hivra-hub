import { expect, test, type Page } from "@playwright/test";

// The pop-out Mono chat beside the main window's chat for the same Lead (mono-chat-stop.tsx): a workflow run held at
// its first agent and one brief out to a worker. Every Stop the main chat shows, the pop-out shows at the same time,
// and pressing it there does what pressing it in the main chat does, in the window that runs the Mono.
type Proof = {
  sent: Array<{ type?: string; request?: { subtype?: string; task_id?: string } }>;
  stops: Array<{ kind: string; [key: string]: unknown }>;
  held(): boolean;
};
const proof = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { proof?: Proof }).proof;
    return p ? { sent: p.sent, stops: p.stops, held: p.held() } : { sent: [], stops: [], held: false };
  });

const SHOTS = process.env.MONO_CHAT_STOP_PROOF_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test.use({ viewport: { width: 1300, height: 760 } });

test("the pop-out chat shows the main chat's Stops while there is work, and they stop the same work", async ({ page }) => {
  await page.goto("/tests/browser/mono-chat-stop.html");
  const main = page.locator("#chat");
  const popout = page.frameLocator("#floating");
  await expect.poll(async () => (await proof(page)).held).toBe(true);

  // Working: the run's Stop and "Waiting on 1 · Stop all" in the main chat, and the same in the pop-out.
  const runStatus = main.locator("[data-workflow-run] [data-workflow-status]").first();
  await expect(runStatus).toHaveText("Scan · 0 of 2 agents done");
  await expect(main.locator("[data-workflow-stop]")).toBeVisible();
  await expect(main.locator('[data-delegation-waiting="1"] [data-delegation-stop-all]')).toBeVisible();
  await expect(popout.locator("[data-workflow-run] [data-workflow-status]").first()).toHaveText(
    "Scan · 0 of 2 agents done",
  );
  await expect(popout.locator("[data-workflow-stop]")).toBeVisible();
  await expect(popout.locator('[data-delegation-waiting="1"]')).toContainText("Waiting on 1");
  await expect(popout.locator('[data-delegation-waiting="1"] [data-delegation-stop-all]')).toBeVisible();
  await expect(popout.getByRole("button", { name: "Stop reply" })).toBeVisible();
  await shot(page, "mono-chat-stop-1-working");

  // Stop all in the pop-out is the main chat's Stop all: the delegation tree's stop for this chat, run by the main
  // window. Both lines go once nothing is out.
  await popout.locator("[data-delegation-stop-all]").click();
  await expect.poll(async () => (await proof(page)).stops).toContainEqual({ kind: "stopTree", chat: "lead" });
  await expect(main.locator("[data-delegation-waiting]")).toHaveCount(0);
  await expect(popout.locator("[data-delegation-waiting]")).toHaveCount(0);

  // The run's Stop in the pop-out reaches Claude Code as the main chat's does: stop_task for that run.
  await popout.locator("[data-workflow-stop]").click();
  await expect
    .poll(async () => (await proof(page)).sent.find((m) => m.request?.subtype === "stop_task")?.request?.task_id)
    .toMatch(/^w/);
  await expect(runStatus).toHaveText("Stopped · 0 of 2 agents done · 2 skipped");
  await expect(popout.locator("[data-workflow-run] [data-workflow-status]").first()).toHaveText(
    "Stopped · 0 of 2 agents done · 2 skipped",
  );

  // Idle: no Stop left in either window, and neither Stop cut the Lead's own turn.
  await expect(main.locator("[data-workflow-stop]")).toHaveCount(0);
  await expect(popout.locator("[data-workflow-stop]")).toHaveCount(0);
  await expect(popout.getByRole("button", { name: "Stop reply" })).toHaveCount(0);
  expect((await proof(page)).stops.filter((stop) => stop.kind === "stop")).toEqual([]);
  await shot(page, "mono-chat-stop-2-stopped");
});
