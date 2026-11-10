import { expect, test, type Page } from "@playwright/test";

// A Lead running a Claude Code workflow, end to end in the browser: the real Claude adapter, registry and chat, fed
// what Claude Code 2.1.302 streamed for a real Workflow run (recorded against a fake API). WP-06 retired Being built.
type Proof = {
  sent: Array<{ type?: string; request?: { subtype?: string; task_id?: string } }>;
  held(): boolean;
  resume(): void;
};
// The fixture puts `proof` on the window from an effect, which can run after `goto` has returned: wait for it.
const proof = async (page: Page) => {
  await page.waitForFunction(() => "proof" in window);
  return page.evaluate(() => {
    const p = (window as unknown as { proof: Proof }).proof;
    return { sent: p.sent, held: p.held() };
  });
};

const SHOTS = process.env.WORKFLOW_PROOF_DIR;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  // Rows open and close over 320 ms (.zen-phase-body); picture them settled.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test.use({ viewport: { width: 1500, height: 760 } });

test("shows the run's phases and agents in the chat, busy then done", async ({ page }) => {
  await page.goto("/tests/browser/workflow-run.html?scenario=run");
  const row = page.locator("[data-workflow-run]").first();
  await expect(row.locator("[data-workflow-status]")).toHaveText("Scan · 1 of 2 agents done");
  await expect(page.locator('[data-workflow-agent="Read parser"]')).toHaveAttribute("data-workflow-agent-state", "done");
  await expect(page.locator('[data-workflow-agent="Read adapter"]')).toHaveAttribute("data-workflow-agent-state", "working");
  await expect(page.locator("[data-workflow-stop]")).toBeVisible();
  await expect.poll(async () => (await proof(page)).held).toBe(true);
  // r67: the Lead's live line says it is waiting on its workers; the run's own row above carries the phase and count.
  await expect(page.locator("[data-mono-work]").first()).toContainText("Waiting on workers");
  await shot(page, "workflow-1-busy");

  await page.evaluate(() => (window as unknown as { proof: Proof }).proof.resume());
  await expect(row.locator("[data-workflow-status]")).toHaveText("Finished · 2 of 3 agents done · 1 failed");
  await expect(page.locator('[data-workflow-agent="Verify findings"]')).toHaveAttribute("data-workflow-agent-state", "failed");
  await expect(page.locator("[data-workflow-stop]")).toHaveCount(0);
  // The Lead's one-line ticker holds each status a moment before the next.
  await expect(page.locator("[data-mono-work]").first()).not.toContainText("Waiting on workers");
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

test("Stop reaches a run known only from its progress frames", async ({ page }) => {
  await page.goto("/tests/browser/workflow-run.html?scenario=stop-unseen");
  await expect(page.locator("[data-workflow-stop]")).toBeVisible();
  await expect.poll(async () => (await proof(page)).held).toBe(true);
  await page.locator("[data-workflow-stop]").click();
  await expect
    .poll(async () => (await proof(page)).sent.find((m) => m.request?.subtype === "stop_task")?.request?.task_id)
    .toMatch(/^w/);
  await expect(page.locator("[data-workflow-run] [data-workflow-status]").first()).toHaveText(
    "Stopped · 0 of 2 agents done · 2 skipped",
  );
  await expect(page.locator("[data-workflow-stop-failed]")).toHaveCount(0);
});

test("a Stop that fails comes back with the reason instead of Stopping… for good", async ({ page }) => {
  await page.goto("/tests/browser/workflow-run.html?scenario=stop-fails");
  await expect.poll(async () => (await proof(page)).held).toBe(true);
  // One click, not Playwright's retried click: the button unmounts as soon as Stop
  // starts, and a retry can press the button that comes back and leave "Stopping…" up.
  await expect(page.locator("[data-workflow-stop]")).toBeVisible();
  await page.locator("[data-workflow-stop]").dispatchEvent("click");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const root = document.querySelector("[data-workflow-run]");
        const failed = document.querySelector("[data-workflow-stop-failed]");
        return {
          reason: (failed?.textContent ?? "").trim(),
          stopBack: document.querySelector("[data-workflow-stop]") != null,
          stopping: (root?.textContent ?? "").includes("Stopping…"),
        };
      }),
    )
    .toEqual({
      reason: "Couldn't stop it: the pipe to Claude Code broke",
      stopBack: true,
      stopping: false,
    });
  await shot(page, "workflow-7-stop-failed");
});

test("an agent in the run opens onto what Claude Code streams for it: its brief, progress and report", async ({ page }) => {
  // Claude Code 2.1.302 streams each workflow agent's prompt preview, counts and result preview (or error), and none
  // of its own messages or tool calls, so that is what an agent's row opens onto.
  await page.goto("/tests/browser/workflow-run.html?scenario=run");
  await expect.poll(async () => (await proof(page)).held).toBe(true);
  const done = page.locator('[data-workflow-agent="Read parser"]');
  await expect(done).toHaveAttribute("data-workflow-agent-state", "done");
  await done.click();
  const doneWork = page.locator('[data-workflow-agent-work="Read parser"]');
  await expect(doneWork.locator("[data-workflow-agent-prompt]")).toHaveText("AGENT-A read the parser");
  await expect(doneWork.locator("[data-workflow-agent-report]")).toHaveText("Read it; nothing wrong.");
  await expect(doneWork.locator("[data-workflow-agent-progress]")).toHaveCount(0);

  const working = page.locator('[data-workflow-agent="Read adapter"]');
  await working.click();
  const workingWork = page.locator('[data-workflow-agent-work="Read adapter"]');
  await expect(workingWork.locator("[data-workflow-agent-prompt]")).toHaveText("AGENT-B read the adapter");
  await expect(workingWork.locator("[data-workflow-agent-prompt]")).toBeVisible();
  await expect(workingWork.locator("[data-workflow-agent-progress]")).toContainText("active");
  await expect(workingWork.locator("[data-workflow-agent-report]")).toHaveCount(0);
  await shot(page, "workflow-4-agent-open");

  // Clicking again folds it away.
  await done.click();
  await expect(doneWork).toHaveCount(0);

  // A failed agent opens itself on its error once the run ends.
  await page.evaluate(() => (window as unknown as { proof: Proof }).proof.resume());
  const failed = page.locator('[data-workflow-agent-work="Verify findings"]');
  await expect(failed.locator("[data-workflow-agent-report]")).toHaveText("API Error: 400 fixture: this agent fails");
  await expect(failed.locator("[data-workflow-agent-prompt]")).toHaveText("FAIL-ME AGENT-C verify findings");
  await shot(page, "workflow-5-agent-failed");
});

test("once the run ends while the Lead's turn goes on, its line says what the Lead does now, not the run", async ({ page }) => {
  await page.goto("/tests/browser/workflow-run.html?scenario=ended");
  await expect.poll(async () => (await proof(page)).held).toBe(true);
  const ticker = page.locator("[data-mono-work] [role=status] .sr-only").first();
  await expect(ticker).toHaveText("Waiting on workers");
  // The ticker just moved to the run's line, so it would hold it for most of its 850 ms. The run ends now.
  const moved = await page.evaluate(async () => {
    const run = () => document.querySelector("[data-workflow-run] [data-workflow-status]")?.textContent ?? "";
    const line = () => document.querySelector("[data-mono-work] [role=status] .sr-only")?.textContent ?? "";
    const wait = async (until: () => boolean) => {
      while (!until()) await new Promise((resolve) => setTimeout(resolve, 5));
      return performance.now();
    };
    (window as unknown as { proof: Proof }).proof.resume();
    const ended = await wait(() => run().startsWith("Finished"));
    const changed = await wait(() => !line().startsWith("Waiting on workers"));
    return { ms: changed - ended, line: line() };
  });
  expect(moved.line).toBe("Thinking");
  expect(moved.ms).toBeLessThan(150);
  await expect(page.locator("[data-mono-work]").first()).not.toContainText("Waiting on workers");
  // Still the Lead's live turn (Claude Code has yet to pick the thread back up). The replay may still be sending the
  // frames up to the run's notification, 40 ms apart, so wait for it to stop there.
  await expect.poll(async () => (await proof(page)).held).toBe(true);
  await expect(page.locator("[data-workflow-run] [data-workflow-status]").first()).toHaveText(
    "Finished · 2 of 3 agents done · 1 failed",
  );
  await shot(page, "workflow-6-run-ended-turn-live");
});
