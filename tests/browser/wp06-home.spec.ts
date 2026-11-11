import { expect, test } from "@playwright/test";
import { EXAMPLE_PROJECTS, openLocalHub, openProjectLead } from "./localHub";

// WP-06: what Today, Being built and Needs you showed, and WP-15 kept, is on the Crew tab or in the Inbox
// of the real app shell (hub-dev.html), not only on the crew fixture page. The hourly digest is WP-15's own spec.
const FOLDER = "/Users/example/Projects/vg-game";
const WORKER = "worker-save";

test.use({ viewport: { width: 1440, height: 900 } });

test("work that left Today and Being built is on the crew or in the inbox", async ({ page }) => {
  const now = Date.now();
  const row = (id: string, title: string, status: string, patch: Record<string, unknown> = {}) => ({
    id,
    project: FOLDER,
    title,
    status,
    childSession: null,
    ownerSession: "lead-session",
    createdAt: now - 60_000,
    updatedAt: now,
    ...patch,
  });
  await page.addInitScript(
    ({ rows, decision, delivery, watch, session }) => {
      localStorage.setItem("monocode:hub-onboarded", "1");
      localStorage.setItem("monocode:hub-setup-not-now", "1");
      localStorage.setItem("monocode:dev-delegations", JSON.stringify(rows));
      localStorage.setItem("monocode:dev-decisions", JSON.stringify([decision]));
      localStorage.setItem("monocode:dev-deliveries", JSON.stringify([delivery]));
      localStorage.setItem("monocode:dev-pr-watches", JSON.stringify([watch]));
      localStorage.setItem("monocode:dev-sessions", JSON.stringify([session]));
    },
    {
      rows: [
        row("working", "Fix the save bug", "working", {
          childSession: WORKER,
          createdAt: now - 12 * 60_000,
        }),
        row("needs", "Pick a name", "needs-you"),
        row("done", "Ship the menu", "done", { settledAt: now }),
        row("failed", "Save the game", "failed", {
          statusNotice: "The save did not finish.",
          error: "sk-live-secret\nat save.ts:10",
        }),
        row("paused", "Wait for the limit", "paused", { errorClass: "usage_limit", error: "usage limit" }),
      ],
      decision: {
        project: FOLDER,
        decisionKey: "ship",
        question: "Ship it now?",
        options: ["Ship it", "Wait"],
        recommended: "Ship it",
        askedBy: "lead-session",
        askedByMono: null,
        waiting: [],
        state: "open",
        answer: null,
        answeredBy: null,
        answeredAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
      delivery: {
        delegationId: "done",
        state: "open",
        url: "https://github.com/example/vg-game/pull/12",
        number: 12,
        updatedAt: now,
      },
      watch: {
        id: "watch-12",
        number: 12,
        url: "https://github.com/example/vg-game/pull/12",
        repo: "example/vg-game",
        status: { pending: 1, passed: false, failed: [], checks: 1 },
      },
      session: {
        id: WORKER,
        cwd: FOLDER,
        harness: "claude",
        model: "opus",
        runtimeMode: "supervised",
        title: "Fix the save bug",
        branch: "fix-save",
        additions: 12,
        deletions: 3,
        createdAt: now - 12 * 60_000,
        updatedAt: now,
      },
    },
  );
  await openLocalHub(page);
  // Dropwave: a project opens on its own home, and its first mates are listed there. The lead's row opens its chat.
  await expect(page.getByRole("button", { name: /^EXO/ }).first()).toBeVisible({ timeout: 60_000 });
  await openProjectLead(page);
  await expect(page.getByRole("main").getByRole("heading", { name: "EXO lead" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("tablist", { name: "Workspace" }).getByRole("tab", { name: "Crew" }).click();
  const crew = (id: string) => page.locator(`[data-crew-row='${id}']`);
  await expect(crew("working")).toBeVisible({ timeout: 15_000 });
  await expect(crew("working")).toContainText("working");
  await expect(crew("needs")).toContainText("needs you");
  await expect(crew("done")).toContainText("done");
  await expect(crew("failed")).toContainText("failed");
  await expect(crew("paused")).toContainText("paused");

  // A worker line: title, cli, model, how long, branch and diff. The minus is the row's own character.
  const working = crew("working");
  await expect(working).toContainText("Fix the save bug");
  await expect(working).toContainText("claude");
  await expect(working).toContainText("opus");
  await expect(working).toContainText("fix-save");
  await expect(working).toContainText("+12");
  await expect(working).toContainText("−3");
  await expect(working).toContainText("12 min");

  const done = crew("done");
  await expect(done).toContainText("Pull request #12");
  await expect(done).toContainText("1 check still going");

  // The project's Inbox, not the retired Today item.
  const sidebar = page.getByRole("navigation", { name: "Projects" }).nth(1);
  await sidebar.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("region", { name: "Inbox" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-inbox-kind=decision]")).toContainText("Ship it now?");
  await expect(page.locator("[data-inbox-kind=decision]")).toContainText("Open the chat");
  const failure = page.locator("[data-inbox-kind=failure]");
  await expect(failure).toContainText("The save did not finish.");
  await expect(failure).not.toContainText("sk-");
  await expect(failure).not.toContainText("at save");
  await expect(page.locator("[data-inbox-kind=credential]")).toContainText("Waiting for a usage limit");
  await expect(page.locator("[data-inbox-kind=review]")).toContainText("Ready for review");
});

test("a project with no code folder does not keep the previous workspace", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("monocode:hub-onboarded", "1");
    localStorage.setItem("monocode:hub-setup-not-now", "1");
  });
  await openLocalHub(page, "", [
    ...EXAMPLE_PROJECTS,
    { id: "sketch", name: "Sketch", shortName: "Sketch", iconShape: "book", folder: null },
  ]);
  // Dropwave: a project opens on its own home, and its first mates are listed there. The lead's row opens its chat.
  await expect(page.getByRole("button", { name: /^EXO/ }).first()).toBeVisible({ timeout: 60_000 });
  await openProjectLead(page);
  await expect(page.getByRole("main").getByRole("heading", { name: "EXO lead" })).toBeVisible({ timeout: 15_000 });

  // Dropwave: any project opens on its own home, so Sketch shows its home and EXO's chat is gone.
  await page.locator("[data-hub-strip]").getByRole("button", { name: "Sketch", exact: true }).click();
  await expect(page.locator("[data-home]").getByRole("heading", { name: "Sketch" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("main").getByRole("heading", { name: "EXO lead" })).toHaveCount(0);

  // A stored coding-team item on Sketch is still the no-code page, not a workspace.
  await page.evaluate(() =>
    (window as unknown as { __devHubSelect(s: unknown): Promise<void> }).__devHubSelect({ project: "sketch", item: "coding-team" }),
  );
  await expect(page.locator("[data-hub-no-code]")).toContainText("This project has no code folder yet.");
  await expect(page.getByRole("main").getByRole("heading", { name: "EXO lead" })).toHaveCount(0);
});
