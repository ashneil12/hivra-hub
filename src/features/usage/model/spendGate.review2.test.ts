// @vitest-environment happy-dom
// WP-176 re-review of #217 (round 2). Each test asserts the outcome the review asked for. The repro on the earlier
// head asserted the broken outcome; these are its flips.
import { beforeEach, describe, expect, it } from "vitest";
import type { UsageSession } from "./history";
import { daysFromSessions } from "./spend";
import {
  admitSpendTurn,
  chatMayWrite,
  forgetSpendMemory,
  judgeLaunch,
  resetSpendGate,
  reviewReportedTurn,
  saveSpendLimit,
  saveTaskCeiling,
  setSpendClock,
  setSpendLoader,
  setSpendPersist,
  setSpendProjectLookup,
  setSpendRecords,
  setSpendSessions,
  setSpendWarnSink,
  spendKey,
  spendLine,
  spendUnreadable,
} from "./spendGate";

const now = Date.parse("2026-11-10T15:00:00");
const HUB = { id: "hivra", folder: "/Users/ash/Projects/monocode-hub" };
const lookup = {
  idOf: (folder: string) => (folder === HUB.folder ? HUB.id : undefined),
  folderOf: (id: string) => (id === HUB.id ? HUB.folder : undefined),
};

function row(id: string, cwd: string, costUsd: number): UsageSession {
  return { id, cwd, harness: "claude", model: "opus", blocks: [{ id: `${id}-t`, role: "user", startedAt: now, turnMetrics: { costUsd, inputTokens: 5 } }] };
}

beforeEach(() => {
  localStorage.clear();
  resetSpendGate();
  setSpendClock(() => now);
  setSpendProjectLookup(lookup);
  setSpendWarnSink({ wake: async () => ({ fresh: true }), activity: () => undefined });
});

describe("A: the app reads the ledger (no loader, no rows, means unreadable)", () => {
  it("with the ledger read and empty, a $1000 limit at $0 reads as spend and admits a worker", async () => {
    setSpendRecords([]);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 1000, warnAt: 0.8 }, 0, { by: "person" });
    expect(spendLine("hivra", "claude")).toMatch(/Spent \$0 of \$1000/);
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("ok");
    expect(await admitSpendTurn({ sessionId: "app-mono-lead-r1", cwd: HUB.folder, harness: "claude", origin: "automated" })).toEqual({ ok: true });
    // A turn this app just measured counts at once, before any read.
    reviewReportedTurn({ sessionId: "x", cwd: HUB.folder, model: "custom:acme", harness: "claude", metrics: { costUsd: 5 } });
    expect(spendLine("hivra", "claude")).toMatch(/Spent \$5 of \$1000/);
  });

  it("a hard task ceiling with no spend yet admits the first billed worker turn", async () => {
    setSpendRecords([]);
    saveTaskCeiling("hivra", { hardUsd: 100 }, 0);
    expect(await admitSpendTurn({ sessionId: "app-mono-lead-r2", cwd: HUB.folder, harness: "claude", model: "custom:acme", origin: "automated" })).toEqual({ ok: true });
  });

  it("a ledger read through the loader is the source: what it reports is what counts", async () => {
    setSpendLoader(async () => daysFromSessions([row("chat", HUB.folder, 5)], () => true) ?? []);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    // Before the first read the gate does not guess: it reports unreadable.
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("ok");
    expect(spendLine("hivra", "claude")).toMatch(/Spent \$5 of \$10/);
  });
});

describe("B: origin decides who is refused (only the composer is a person)", () => {
  beforeEach(() => {
    setSpendSessions([row("chat", HUB.folder, 500)]);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
  });

  it("a worker in its own <project>-worktrees checkout is refused (control)", async () => {
    expect(await admitSpendTurn({ sessionId: "app-mono-lead-r3", cwd: `${HUB.folder}-worktrees/mc-1`, harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
  });

  it("an orchestration worker (uuid id) in a worktree-pool slot is refused", async () => {
    const slot = "/Users/ash/Worktrees/pool/monocode-hub-slot1";
    expect(spendKey(slot)).toBe("/Users/ash/Worktrees/pool/monocode-hub-slot1");
    // The pool slot resolves to the main checkout through git. Here git is stubbed to say so.
    setSpendProjectLookup({ ...lookup, resolveFolder: async () => HUB.folder });
    await admitSpendTurn({ sessionId: "warm", cwd: slot, harness: "claude", origin: "automated" });
    expect(await admitSpendTurn({ sessionId: "4b8f6a1e-0000-4000-8000-000000000001", cwd: slot, harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
  });

  it("an orchestration worker (uuid id) even in a <project>-worktrees checkout is refused", async () => {
    expect(await admitSpendTurn({ sessionId: "4b8f6a1e-0000-4000-8000-000000000002", cwd: `${HUB.folder}-worktrees/orch-1`, harness: "claude" })).toMatchObject({ ok: false });
  });

  it("an automation run (no origin, so automated) is refused", async () => {
    expect(await admitSpendTurn({ sessionId: "5c9f6a1e-0000-4000-8000-000000000003", cwd: HUB.folder, harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
  });

  it("an agent's sessions.send into a person's chat, with no person origin, is refused", async () => {
    expect(await admitSpendTurn({ sessionId: "person-chat-uuid", cwd: HUB.folder, harness: "claude" })).toMatchObject({ ok: false });
  });

  it("the composer's own turn is never refused, only warned", async () => {
    expect(await admitSpendTurn({ sessionId: "person-chat-uuid", cwd: HUB.folder, harness: "claude", origin: "person" })).toEqual({ ok: true });
  });

  it("a wake or timer turn in the first mate's own chat, with no person origin, is refused", async () => {
    expect(await admitSpendTurn({ sessionId: "mono-lead", cwd: HUB.folder, harness: "claude" })).toMatchObject({ ok: false });
  });

  it("a habit run of a non-Lead Mono is judged against its Mono's project, even from home", async () => {
    setSpendProjectLookup({ ...lookup, projectOfSession: (id) => (id === "habit-run-1" ? HUB.id : undefined) });
    expect(await admitSpendTurn({ sessionId: "habit-run-1", cwd: "/Users/ash", harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
  });
});

describe("C: unreadable storage is checked before anything else", () => {
  it("a worker and a habit are refused when the stored limits cannot be read", async () => {
    localStorage.setItem("monocode:spend-limits", "{not json");
    forgetSpendMemory();
    expect(spendUnreadable()).toBe(true);
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
    expect(await admitSpendTurn({ sessionId: "app-mono-lead-r9", cwd: HUB.folder, harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
  });
});

describe("D: a first mate's write is keyed the same as the person's", () => {
  it("a person's limit stored under the folder string is the same limit a first mate writes under the hub id", () => {
    setSpendProjectLookup(null);
    expect(saveSpendLimit({ scope: "project", project: HUB.folder, period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" }).written).toBe(true);
    setSpendProjectLookup(lookup);
    const raised = saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 999999, warnAt: 1 }, 1, { by: "first-mate" });
    expect(raised.written).toBe(false);
    expect(chatMayWrite("first-mate", { scope: "project", project: "hivra", period: "month", amountUsd: 5, warnAt: 0.8 }, { scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }).ok).toBe(true);
    setSpendSessions([row("chat", HUB.folder, 50)]);
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
  });
});

describe("persisted turns reach the ledger once", () => {
  it("a turn is written through the persist function with its project key", async () => {
    const written: unknown[] = [];
    setSpendPersist(async (entry) => {
      written.push(entry);
    });
    setSpendRecords([]);
    reviewReportedTurn({ sessionId: "s1", cwd: HUB.folder, model: "custom:acme", harness: "claude", metrics: { costUsd: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toEqual([expect.objectContaining({ sessionId: "s1", projectKey: HUB.id, micros: 2_000_000, priced: true })]);
  });
});
