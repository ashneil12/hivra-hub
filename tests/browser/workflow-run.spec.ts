import { expect, test, type Page } from "@playwright/test";

// A Lead running a Claude Code workflow, end to end in the browser: the real Claude adapter, registry, chat and Being
// built, fed what Claude Code 2.1.302 streamed for a real Workflow run (recorded against a fake API).
type Proof = {
  sent: Array<{ type?: string; request?: { subtype?: string; task_id?: string } }>;
  held(): boolean;
  resume(): void;
};
const proof = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { proof: Proof }).proof;
    return { sent: p.sent, held: p.held() };
  });

const SHOTS = process.env.WORKFLOW_PROOF_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test.use({ viewport: { width: 1500, height: 760 } });

test("shows the run's phases and agents in the chat and in Being built, busy then done", async ({ page }) => {
  await page.goto("/tests/browser/workflow-run.html?scenario=run");
  const row = page.locator("[data-workflow-run]").first();
  await expect(row.locator("[data-workflow-status]")).toHaveText("Scan · 1 of 2 agents done");
  await expect(page.locator('[data-workflow-agent="Read parser"]')).toHaveAttribute("data-workflow-agent-state", "done");
  await expect(page.locator('[data-workflow-agent="Read adapter"]')).toHaveAttribute("data-workflow-agent-state", "working");
  await expect(page.locator("[data-workflow-stop]")).toBeVisible();
  await expect(page.locator("[data-hub-being-built]")).toContainText("running workflow: Scan (1/2 agents)");
  await expect(page.locator("[data-hub-being-built]")).toContainText("EXO lead");
  await expect.poll(async () => (await proof(page)).held).toBe(true);
  await expect(page.locator("[data-mono-work]").first()).toContainText("Running workflow: Scan (1/2 agents)");
  await shot(page, "workflow-1-busy");

  await page.evaluate(() => (window as unknown as { proof: Proof }).proof.resume());
  await expect(row.locator("[data-workflow-status]")).toHaveText("Finished · 2 of 3 agents done · 1 failed");
  await expect(page.locator('[data-workflow-agent="Verify findings"]')).toHaveAttribute("data-workflow-agent-state", "failed");
  await expect(page.locator("[data-workflow-stop]")).toHaveCount(0);
  await expect(page.locator("[data-hub-being-built]")).not.toContainText("running workflow");
  // The Lead's one-line ticker holds each status a moment before the next.
  await expect(page.locator("[data-mono-work]").first()).not.toContainText("Running workflow");
  await shot(page, "workflow-2-done");
});

test("one Stop ends the whole run", async ({ page }) => {
  await page.goto("/tests/browser/workflow-run.html?scenario=stop");
  await expect(page.locator("[data-workflow-stop]")).toBeVisible();
  await expect.poll(async () => (await proof(page)).held).toBe(true);
  await page.locator("[data-workflow-stop]").click();
  await expect
    .poll(async () => (await proof(page)).sent.find((m) => m.request?.subtype === "stop_task")?.request?.task_id)
    .toMatch(/^w/);
  await expect(page.locator("[data-workflow-run] [data-workflow-status]").first()).toHaveText(
    "Stopped · 0 of 2 agents done · 2 skipped",
  );
  await shot(page, "workflow-3-stopped");
});
