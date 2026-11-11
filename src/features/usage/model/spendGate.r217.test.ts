// @vitest-environment happy-dom
// WP-176 review of #217. Each test names the review item it proves. The project fixture's hub id ("hivra") is not
// its folder name ("/work/monocode-hub"), so a key that only matches folders or ids fails here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSession } from "./history";
import { daysFromSessions } from "./spend";
import {
  admitSpendTurn,
  chatMayWrite,
  clearSpendLimit,
  forgetSpendMemory,
  judgeLaunch,
  projectFolderOfCwd,
  replaceUnreadableSpendStore,
  resetSpendGate,
  reviewReportedTurn,
  saveSpendLimit,
  saveTaskCeiling,
  setSpendClock,
  setSpendLoader,
  setSpendMonotonicClock,
  setSpendProjectLookup,
  setSpendSessions,
  setSpendWarnSink,
  spendKey,
  spendUnreadable,
  type SpendSinkEvent,
} from "./spendGate";

const month = Date.parse("2026-11-10T15:00:00");
const HUB = { id: "hivra", folder: "/work/monocode-hub" };
const lookup = {
  idOf: (folder: string) => (folder === HUB.folder ? HUB.id : undefined),
  folderOf: (id: string) => (id === HUB.id ? HUB.folder : undefined),
};

function row(id: string, cwd: string, costUsd: number, at = month, model = "opus"): UsageSession {
  return { id, cwd, harness: "claude", model, blocks: [{ id: `${id}-t`, role: "user", startedAt: at, turnMetrics: { costUsd, inputTokens: 5 } }] };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

let events: SpendSinkEvent[] = [];
const wakes: string[] = [];

beforeEach(() => {
  localStorage.clear();
  resetSpendGate();
  setSpendClock(() => month);
  setSpendProjectLookup(lookup);
  events = [];
  wakes.length = 0;
  setSpendWarnSink({
    wake: async (input) => {
      wakes.push(input.key);
      return { fresh: true };
    },
    activity: (input) => {
      events.push({ kind: input.kind, summary: input.summary, project: input.project });
    },
  });
});

describe("C2: limits and spend share one project key", () => {
  it("a limit saved under the hub id is judged against spend in the folder it names", () => {
    setSpendSessions([row("chat", "/work/monocode-hub", 50)]);
    expect(saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" }).written).toBe(true);
    expect(judgeLaunch({ project: "hivra", harness: "claude" })).toMatchObject({ status: "over" });
  });

  it("a limit saved under the folder is the same limit as the hub id", () => {
    setSpendSessions([row("chat", "/work/monocode-hub", 50)]);
    saveSpendLimit({ scope: "project", project: "/work/monocode-hub", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
    expect(spendKey("/work/monocode-hub")).toBe("hivra");
  });

  it("a folder that merely shares a basename with the project does not count", () => {
    setSpendSessions([row("chat", "/elsewhere/monocode-hub", 50)]);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("ok");
  });
});

describe("C1: spend is read again, not frozen at the first read", () => {
  it("a limit moves from ok to over as spend grows after the first read", async () => {
    let monotonicMs = 0;
    setSpendMonotonicClock(() => monotonicMs);
    let rows: UsageSession[] = [row("chat", "/work/monocode-hub", 1)];
    setSpendLoader(async () => daysFromSessions(rows, () => false) ?? []);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    judgeLaunch({ project: "hivra", harness: "claude" });
    await flush();
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("ok");

    rows = [row("chat", "/work/monocode-hub", 501)];
    setSpendClock(() => month + 60_000);
    // The record TTL runs on the monotonic clock (WP-176 round 3), so the test moves that clock past it.
    monotonicMs += 60_000;
    judgeLaunch({ project: "hivra", harness: "claude" });
    await flush();
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
  });
});

describe("H4: a worktree counts toward its project", () => {
  it("a worktree folder maps to the project folder, and its spend counts", () => {
    expect(projectFolderOfCwd("/work/monocode-hub-worktrees/feat-x")).toBe("/work/monocode-hub");
    setSpendSessions([row("worker", "/work/monocode-hub-worktrees/feat-x", 50)]);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
  });
});

describe("H5: a held run stays held, from usage rows, across a restart", () => {
  it("a session past its task ceiling refuses the next turn until the ceiling is raised", async () => {
    setSpendSessions([row("worker-1", "/work/monocode-hub", 9.5)]);
    saveTaskCeiling("hivra", { hardUsd: 9, softAt: 0.8 }, 0);
    const first = await admitSpendTurn({ sessionId: "worker-1", cwd: "/work/monocode-hub", harness: "claude", model: "custom:acme-model" });
    expect(first.ok).toBe(false);
    forgetSpendMemory();
    const again = await admitSpendTurn({ sessionId: "worker-1", cwd: "/work/monocode-hub", harness: "claude", model: "custom:acme-model" });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toMatch(/Task ceiling reached/);
    saveTaskCeiling("hivra", { hardUsd: 20, softAt: 0.8 }, spendRevision());
    expect((await admitSpendTurn({ sessionId: "worker-1", cwd: "/work/monocode-hub", harness: "claude", model: "custom:acme-model" })).ok).toBe(true);
  });
});

describe("H3: who may write a limit, per scope and writer", () => {
  const limit = (amountUsd: number, scope: "project" | "app" = "project", warnAt = 0.8) => ({
    scope,
    project: scope === "app" ? "" : "hivra",
    period: "month" as const,
    amountUsd,
    warnAt,
  });

  it("project scope: a first mate may set a first limit and lower one, never raise or clear", () => {
    expect(chatMayWrite("first-mate", limit(50), undefined).ok).toBe(true);
    expect(chatMayWrite("first-mate", limit(20), limit(50)).ok).toBe(true);
    expect(chatMayWrite("first-mate", limit(900), limit(50)).ok).toBe(false);
    expect(chatMayWrite("first-mate", null, limit(50))).toMatchObject({ ok: false });
    expect(chatMayWrite("person", limit(900), limit(50)).ok).toBe(true);
    expect(chatMayWrite("person", null, limit(50)).ok).toBe(true);
  });

  it("app scope: no chat may write the whole-app limit, only Settings", () => {
    expect(chatMayWrite("first-mate", limit(50, "app"), undefined)).toMatchObject({ ok: false });
    expect(chatMayWrite("person", limit(50, "app"), undefined).ok).toBe(true);
  });

  it("habits and workers and checkers can write nothing", () => {
    for (const writer of ["habit", "worker", "checker"] as const) {
      expect(chatMayWrite(writer, limit(20), undefined).ok).toBe(false);
    }
  });

  it("every change posts an activity line, for project and app scope", () => {
    saveSpendLimit(limit(50), 0, { by: "person" });
    saveSpendLimit(limit(50, "app"), spendRevision(), { by: "person" });
    clearSpendLimit("project", "hivra", "month", spendRevision(), { by: "person" });
    expect(events.map((event) => event.kind)).toEqual(["spend.changed", "spend.changed", "spend.changed"]);
    expect(events[1].project).toBe("app");
  });
});

describe("MEDIUM 6: a daily ceiling with no spend yet does not stop an unattended turn", () => {
  it("a small turn against a large daily ceiling is not stopped", () => {
    setSpendSessions([]);
    saveTaskCeiling("hivra", { dailyUsd: 100 }, 0);
    const verdict = reviewReportedTurn({
      sessionId: "auto-1",
      cwd: "/work/monocode-hub",
      model: "custom:acme-model",
      harness: "claude",
      metrics: { costUsd: 0.01 },
      unattended: true,
    });
    expect(verdict.stopRun).toBe(false);
  });
});

describe("MEDIUM 8: switching CLI does not dodge an over limit", () => {
  it("a codex launch is refused when the project is over", () => {
    setSpendSessions([row("chat", "/work/monocode-hub", 50)]);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    expect(judgeLaunch({ project: "hivra", harness: "codex" }).status).toBe("over");
  });
});

describe("MEDIUM 7: unreadable storage holds launches until the person replaces it", () => {
  it("corrupt storage reads as over, and a replace clears the hold", () => {
    localStorage.setItem("monocode:spend-limits", "{not json");
    forgetSpendMemory();
    expect(spendUnreadable()).toBe(true);
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
    replaceUnreadableSpendStore();
    expect(spendUnreadable()).toBe(false);
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("unset");
  });
});

describe("MEDIUM 9: unattended means a habit or worker, and the daily total is per project", () => {
  it("a worker's day total in one project does not count against another", async () => {
    setSpendSessions([row("other", "/work/other", 50)]);
    saveTaskCeiling("hivra", { dailyUsd: 10 }, 0);
    expect((await admitSpendTurn({ sessionId: "app-x", cwd: "/work/monocode-hub", harness: "claude", model: "custom:acme-model", origin: "automated" })).ok).toBe(true);
  });
});

describe("MEDIUM 11: one admission point; automated runs refuse, person chats warn", () => {
  it("a worker over the limit is refused, a person's chat is allowed and warned", async () => {
    setSpendSessions([row("chat", "/work/monocode-hub", 50)]);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    const worker = await admitSpendTurn({ sessionId: "app-w", cwd: "/work/monocode-hub", harness: "claude", origin: "automated" });
    expect(worker.ok).toBe(false);
    const person = await admitSpendTurn({ sessionId: "person-chat", cwd: "/work/monocode-hub", harness: "claude", origin: "person" });
    expect(person.ok).toBe(true);
  });
});

function spendRevision(): number {
  return JSON.parse(localStorage.getItem("monocode:spend-limits") ?? '{"revision":0}').revision ?? 0;
}

// Unused-in-ceiling imports kept for the reviewer's probe list.
void vi;
void reviewReportedTurn;
