import { expect, test, type Page } from "@playwright/test";

// WP-91's live goal graph, on the real orchestrator store (tests/browser/goal-graph.tsx). Runs are written through the
// store's own commit, so the graph hears each change the way it does from a live worker; a reload reads the saved run.
// Runs in Chromium and WebKit (playwright.config.ts): npx playwright test tests/browser/goal-graph.spec.ts

const LEAD = "goal-lead";
const GOAL = "The export button saves a valid file";
const FOLDER = "/Users/example/Projects/vg-game";

type Run = Record<string, unknown>;
type Patch = Record<string, unknown>;

const task = (id: string, patch: Patch = {}) => ({
  id,
  sessionId: `s-${id}`,
  title: id.replace(/^t-/, "").replace(/-/g, " "),
  harness: "claude",
  model: "claude:sonnet-5",
  prompt: "Do the work.",
  files: [`src/${id}/`],
  scopes: [`src/${id}/`],
  dependsOn: [],
  status: "queued",
  accepted: false,
  result: "",
  delivered: false,
  ...patch,
});

const handoff = (read: boolean) => ({ path: "/checkout/.hivra/handoff/t.md", sha256: "ab", bytes: 12, read, at: 1 });

function run(
  tasks: Record<string, unknown>[],
  layers: string[][],
  patch: Patch = {},
): Run {
  return {
    version: 2,
    leadId: LEAD,
    cwd: FOLDER,
    status: "active",
    allowedHarnesses: ["claude"],
    maxWorkers: 2,
    cli: "claude",
    tasks,
    continuations: 0,
    requests: {},
    goal: GOAL,
    check: { command: "npm test", expectExit: 0 },
    baseline: { outcome: "failed", exitCode: 1, output: "2 tests failing", layer: "app", at: 1 },
    checkRuns: [],
    goalReport: {
      goal: GOAL,
      verdict: "unverified",
      reasons: ["tasks_open:open", "verification_open:t-verify"],
      layers,
      criticalPath: [],
      bottlenecks: [],
      lint: [],
      ready: [],
      cyclesLeft: {},
      replan: [],
      extendsLeft: 2,
    },
    ...patch,
  };
}

/** Three layers: a plan accepted, two builds (one running, one done but unread), and the verify task. */
function liveRun(): Run {
  return run(
    [
      task("t-plan", { status: "completed", accepted: true, handoff: handoff(true) }),
      task("t-ui", { status: "running", dependsOn: ["t-plan"] }),
      task("t-data", { status: "completed", dependsOn: ["t-plan"], handoff: handoff(false) }),
      task("t-verify", { role: "verify", dependsOn: ["t-ui", "t-data"] }),
    ],
    [["t-plan"], ["t-ui", "t-data"], ["t-verify"]],
  );
}

/** A failed build with its repair node (cycle 1) under it, then the verify task after both. */
function repairRun(): Run {
  return run(
    [
      task("t-plan", { status: "completed", accepted: true, handoff: handoff(true) }),
      task("t-api", { status: "failed", dependsOn: ["t-plan"] }),
      task("t-api-fix", { repairs: "t-api", cycle: 1, status: "queued", dependsOn: ["t-plan"] }),
      task("t-verify", { role: "verify", dependsOn: ["t-api", "t-api-fix"] }),
    ],
    [["t-plan"], ["t-api", "t-api-fix"], ["t-verify"]],
    { repairCycles: { "t-api": [["t-api-fix"]] } },
  );
}

/** The plan and its verify task accepted, then a node an extend round added from the verify task. */
function extendRun(): Run {
  return run(
    [
      task("t-plan", { status: "completed", accepted: true, handoff: handoff(true) }),
      task("t-verify", {
        role: "verify",
        status: "completed",
        accepted: true,
        dependsOn: ["t-plan"],
        handoff: handoff(true),
      }),
      task("t-more", { dependsOn: ["t-verify"], extendFrom: "t-verify" }),
    ],
    [["t-plan"], ["t-verify"], ["t-more"]],
    { extends: 1 },
  );
}

/** Fourteen tasks: layers one and two are all accepted, layer three has one running task, then the verify task. */
function bigRun(extraCheck = false): Run {
  const accepted = (id: string, dependsOn: string[]) =>
    task(id, { status: "completed", accepted: true, dependsOn, handoff: handoff(true) });
  const tasks = [
    accepted("t-a", []),
    ...["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => accepted(`t-${id}`, ["t-a"])),
    task("t-c1", { status: "running", dependsOn: ["t-a"] }),
    ...["c2", "c3", "c4", "c5", "c6"].map((id) => accepted(`t-${id}`, ["t-a"])),
    task("t-verify", {
      role: "verify",
      dependsOn: ["t-c1", "t-c2", "t-c3", "t-c4", "t-c5", "t-c6"],
    }),
  ];
  const layers = [
    ["t-a"],
    ["t-b1", "t-b2", "t-b3", "t-b4", "t-b5", "t-b6"],
    ["t-c1", "t-c2", "t-c3", "t-c4", "t-c5", "t-c6"],
    ["t-verify"],
  ];
  return run(tasks, layers, {
    checkRuns: extraCheck
      ? [{ outcome: "failed", output: "still failing", layer: "app", at: 2 }]
      : [],
  });
}

const commit = (page: Page, next: Run) =>
  page.evaluate(
    (value) =>
      (window as unknown as { __goalGraph: { commit(r: unknown): Promise<void> } }).__goalGraph.commit(value),
    next,
  );
const node = (page: Page, id: string) => page.locator(`[data-goal-node="${id}"]`);
const layerToggle = (page: Page, level: number) => page.locator(`[data-goal-layer-toggle="${level}"]`);
const nodeToggle = (page: Page, id: string) => page.locator(`[data-goal-node-toggle="${id}"]`);

async function open(page: Page) {
  await page.goto("/tests/browser/goal-graph.html");
  await expect(page.locator("#root")).toBeAttached();
}

test("a live run draws its layers, its goal and check, and each node's state", async ({ page }) => {
  await open(page);
  await commit(page, liveRun());

  await expect(page.locator("[data-goal-graph]")).toBeVisible();
  await expect(page.locator("[data-goal-goal]")).toHaveText(GOAL);
  await expect(page.locator("[data-goal-check]")).toContainText("npm test (exit 0)");
  await expect(page.locator("[data-goal-baseline]")).toContainText("failed before any work, as it should");
  await expect(page.locator("[data-goal-verdict]")).toHaveAttribute("data-goal-verdict", "unverified");
  await expect(page.locator("[data-goal-verdict]")).toContainText("Not verified yet");

  await expect(page.locator("[data-goal-layer]")).toHaveCount(3);
  await expect(page.locator('[data-goal-layer="1"] [data-goal-node="t-plan"]')).toHaveAttribute("data-goal-state", "accepted");
  await expect(page.locator('[data-goal-layer="2"] [data-goal-node="t-ui"]')).toHaveAttribute("data-goal-state", "running");
  await expect(page.locator('[data-goal-layer="2"] [data-goal-node="t-data"]')).toHaveAttribute("data-goal-state", "completed");
  await expect(node(page, "t-plan")).toHaveAttribute("data-goal-handoff", "read");
  await expect(node(page, "t-data")).toHaveAttribute("data-goal-handoff", "unread");
  await expect(node(page, "t-data").locator("text=Handoff not read")).toBeVisible();
  await expect(node(page, "t-verify")).toContainText("Verify");
  await expect(page.locator('[data-goal-edge="after"]').first()).toContainText("After");
});

test("a repair edge sits under the node it came from, and the verify node is marked", async ({ page }) => {
  await open(page);
  await commit(page, repairRun());

  await expect(node(page, "t-api")).toHaveAttribute("data-goal-state", "failed");
  const edge = page.locator('[data-goal-edge="repair"][data-goal-from="t-api"][data-goal-to="t-api-fix"]');
  await expect(edge).toBeVisible();
  await expect(edge).toContainText("Repair, cycle 1");
  await expect(node(page, "t-api-fix")).toHaveAttribute("data-goal-repair", "t-api");
  await expect(node(page, "t-api-fix")).toContainText("Repair 1");

  await expect(page.locator("[data-goal-verify]")).toHaveCount(1);
  await expect(node(page, "t-verify")).toHaveAttribute("data-goal-verify", "");
});

test("an extend edge sits under the node whose check found the work", async ({ page }) => {
  await open(page);
  await commit(page, extendRun());

  const edge = page.locator(
    '[data-goal-edge="extend"][data-goal-from="t-verify"][data-goal-to="t-more"]',
  );
  await expect(edge).toBeVisible();
  await expect(edge).toContainText("Extended");
  await expect(node(page, "t-more")).toHaveAttribute("data-goal-extend", "");
});

test("a run whose tasks no gate checked says so beside its verdict", async ({ page }) => {
  await open(page);
  const ungated = liveRun();
  (ungated.goalReport as { lint: string[] }).lint = ["no_gates:t-plan,t-data"];
  await commit(page, ungated);

  await expect(page.locator("[data-goal-verdict]")).toContainText(
    "No gate ran on t-plan, t-data, so those were accepted without one.",
  );
});

test("a settling task updates in place, without a reload", async ({ page }) => {
  await open(page);
  await commit(page, liveRun());
  await expect(node(page, "t-ui")).toHaveAttribute("data-goal-state", "running");
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: number }).__sameDocument = 1;
  });

  await commit(
    page,
    run(
      [
        task("t-plan", { status: "completed", accepted: true, handoff: handoff(true) }),
        task("t-ui", { status: "completed", accepted: true, dependsOn: ["t-plan"], handoff: handoff(true) }),
        task("t-data", { status: "completed", dependsOn: ["t-plan"], handoff: handoff(false) }),
        task("t-verify", { role: "verify", dependsOn: ["t-ui", "t-data"] }),
      ],
      [["t-plan"], ["t-ui", "t-data"], ["t-verify"]],
    ),
  );

  await expect(node(page, "t-ui")).toHaveAttribute("data-goal-state", "accepted");
  await expect(node(page, "t-ui")).toHaveAttribute("data-goal-handoff", "read");
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: number }).__sameDocument)).toBe(1);
});

test("a reload redraws the saved run", async ({ page }) => {
  await open(page);
  await commit(
    page,
    run(
      [
        task("t-plan", { status: "completed", accepted: true, handoff: handoff(true) }),
        task("t-build", { status: "completed", accepted: true, dependsOn: ["t-plan"], handoff: handoff(true) }),
        task("t-verify", { role: "verify", status: "completed", accepted: true, dependsOn: ["t-build"], handoff: handoff(true) }),
      ],
      [["t-plan"], ["t-build"], ["t-verify"]],
      {
        status: "finished",
        goalReport: {
          goal: GOAL,
          verdict: "verified",
          reasons: [],
          layers: [["t-plan"], ["t-build"], ["t-verify"]],
          criticalPath: [],
          bottlenecks: [],
          lint: [],
          ready: [],
          cyclesLeft: {},
          replan: [],
          extendsLeft: 2,
        },
      },
    ),
  );

  await page.reload();
  await expect(node(page, "t-plan")).toHaveAttribute("data-goal-state", "accepted");
  await expect(node(page, "t-verify")).toHaveAttribute("data-goal-state", "accepted");
  await expect(page.locator("[data-goal-verdict]")).toHaveAttribute("data-goal-verdict", "verified");
});

test("a big graph folds its quiet layers, and the person's folds win", async ({ page }) => {
  await open(page);
  await commit(page, bigRun());

  // Layers one and two are all accepted, so they open folded; layer three has a running task, so it opens.
  await expect(layerToggle(page, 1)).toHaveAttribute("aria-expanded", "false");
  await expect(layerToggle(page, 2)).toHaveAttribute("aria-expanded", "false");
  await expect(node(page, "t-a")).toHaveCount(0);
  await expect(node(page, "t-b1")).toHaveCount(0);
  await expect(layerToggle(page, 3)).toHaveAttribute("aria-expanded", "true");
  await expect(node(page, "t-c1")).toBeVisible();
  // Accepted nodes in an open layer fold to one line.
  await expect(nodeToggle(page, "t-c2")).toHaveAttribute("aria-expanded", "false");

  // The person opens layer two. A later write that leaves it quiet must not fold it again.
  await layerToggle(page, 2).click();
  await expect(node(page, "t-b1")).toBeVisible();
  await commit(page, bigRun(true));
  await expect(node(page, "t-b1")).toBeVisible();
  await expect(layerToggle(page, 2)).toHaveAttribute("aria-expanded", "true");

  // The person closes layer three, which is still live. A later write that finishes its task must keep it closed.
  await layerToggle(page, 3).click();
  await expect(layerToggle(page, 3)).toHaveAttribute("aria-expanded", "false");
  const settled = bigRun(true) as { tasks: Record<string, unknown>[] };
  settled.tasks = settled.tasks.map((entry) =>
    entry.id === "t-c1" ? task("t-c1", { status: "completed", accepted: true, dependsOn: ["t-a"], handoff: handoff(true) }) : entry,
  );
  await commit(page, settled as Run);
  await expect(node(page, "t-c1")).toHaveCount(0);
  await expect(layerToggle(page, 3)).toHaveAttribute("aria-expanded", "false");
});

test("a finished run's close names the usage its children recorded", async ({ page }) => {
  await open(page);
  const finished = run(
    [task("t-plan", { status: "completed", accepted: true, handoff: handoff(true) })],
    [["t-plan"]],
    {
      status: "finished",
      closingUsage: { inputTokens: 12, outputTokens: 340 },
      goalReport: {
        goal: GOAL,
        verdict: "verified",
        reasons: [],
        layers: [["t-plan"]],
        criticalPath: [],
        bottlenecks: [],
        lint: [],
        ready: [],
        cyclesLeft: {},
        replan: [],
        extendsLeft: 2,
      },
    },
  );
  await commit(page, finished);
  await expect(page.locator("[data-goal-usage]")).toHaveText("Children used 12 in, 340 out.");

  const live = liveRun();
  (live as { closingUsage?: unknown }).closingUsage = { outputTokens: 340 };
  await commit(page, live);
  await expect(page.locator("[data-goal-usage]")).toHaveCount(0);

  const quiet = run(
    [task("t-plan", { status: "completed", accepted: true, handoff: handoff(true) })],
    [["t-plan"]],
    { status: "finished", closingUsage: { outputTokens: 0, inputTokens: "no" } },
  );
  await commit(page, quiet);
  await expect(page.locator("[data-goal-usage]")).toHaveCount(0);
  await expect(page.locator("[data-goal-graph]")).not.toContainText("Children used");
});
