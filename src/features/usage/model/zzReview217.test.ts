// @vitest-environment happy-dom
// Reviewer scratch test for #217 round 2. Not part of the PR.
import { beforeEach, describe, expect, it } from "vitest";
import type { UsageSession } from "./history";
import {
  admitSpendTurn,
  judgeLaunch,
  resetSpendGate,
  saveSpendLimit,
  saveTaskCeiling,
  setSpendChatKind,
  setSpendClock,
  setSpendProjectLookup,
  setSpendSessions,
  setSpendWarnSink,
  spendKey,
  spendLine,
  reviewReportedTurn,
  type ChatKind,
} from "./spendGate";

const now = Date.parse("2026-11-10T15:00:00");
const HUB = { id: "hivra", folder: "/Users/ash/Projects/monocode-hub" };
const lookup = {
  idOf: (folder: string) => (folder === HUB.folder ? HUB.id : undefined),
  folderOf: (id: string) => (id === HUB.id ? HUB.folder : undefined),
};
// The same rule spendWiring.ts uses: habit map, Mono map, then the app- prefix, else a person's chat.
const habits = new Set<string>();
const monos = new Set<string>(["mono-lead"]);
const kind = (id: string): ChatKind => (habits.has(id) ? "habit" : monos.has(id) ? "mono" : id.startsWith("app-") ? "worker" : "chat");

function row(id: string, cwd: string, costUsd: number): UsageSession {
  return { id, cwd, harness: "claude", model: "opus", blocks: [{ id: `${id}-t`, role: "user", startedAt: now, turnMetrics: { costUsd, inputTokens: 5 } }] };
}

beforeEach(() => {
  localStorage.clear();
  resetSpendGate();
  setSpendClock(() => now);
  setSpendProjectLookup(lookup);
  setSpendChatKind(kind);
  setSpendWarnSink({ wake: async () => ({ fresh: true }), activity: () => undefined });
});

describe("A: the app never loads usage rows (no setSpendLoader/setSpendSessions outside tests)", () => {
  it("with the app's wiring, every limit reads 'could not be read' and every worker is refused at $0 spend", async () => {
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 1000, warnAt: 0.8 }, 0, { by: "person" });
    expect(spendLine("hivra", "claude")).toMatch(/could not be read/);
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
    const worker = await admitSpendTurn({ sessionId: "app-mono-lead-r1", cwd: HUB.folder, harness: "claude" });
    expect(worker).toMatchObject({ ok: false });
    // the ledger is never consulted when rows are null
    reviewReportedTurn({ sessionId: "x", cwd: HUB.folder, model: "custom:acme", harness: "claude", metrics: { costUsd: 5 } });
    expect(spendLine("hivra", "claude")).toMatch(/could not be read/);
  });

  it("a hard task ceiling refuses every billed worker turn, even the first, when rows never load", async () => {
    saveTaskCeiling("hivra", { hardUsd: 100 }, 0);
    const first = await admitSpendTurn({ sessionId: "app-mono-lead-r2", cwd: HUB.folder, harness: "claude", model: "custom:acme" });
    expect(first).toMatchObject({ ok: false });
  });
});

describe("B: over-limit spend that is admitted", () => {
  beforeEach(() => {
    setSpendSessions([row("chat", HUB.folder, 500)]);
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
  });

  it("a worker in its own <project>-worktrees checkout is refused (control)", async () => {
    expect(await admitSpendTurn({ sessionId: "app-mono-lead-r3", cwd: `${HUB.folder}-worktrees/mc-1`, harness: "claude" })).toMatchObject({ ok: false });
  });

  it("an orchestration worker (uuid id) in a worktree-pool slot is admitted", async () => {
    const slot = "/Users/ash/Worktrees/pool/monocode-hub-slot1";
    expect(spendKey(slot)).not.toBe("hivra");
    expect(await admitSpendTurn({ sessionId: "4b8f6a1e-0000-4000-8000-000000000001", cwd: slot, harness: "claude" })).toEqual({ ok: true });
  });

  it("an orchestration worker (uuid id) even in a <project>-worktrees checkout is admitted (kind 'chat')", async () => {
    expect(await admitSpendTurn({ sessionId: "4b8f6a1e-0000-4000-8000-000000000002", cwd: `${HUB.folder}-worktrees/orch-1`, harness: "claude" })).toEqual({ ok: true });
  });

  it("an automation run (newSession uuid id, automationId on the session) is admitted", async () => {
    expect(await admitSpendTurn({ sessionId: "5c9f6a1e-0000-4000-8000-000000000003", cwd: HUB.folder, harness: "claude" })).toEqual({ ok: true });
  });

  it("an agent's sessions.send into a person's chat in the project is admitted", async () => {
    expect(await admitSpendTurn({ sessionId: "person-chat-uuid", cwd: HUB.folder, harness: "claude" })).toEqual({ ok: true });
  });

  it("a wake/timer/room turn in the first mate's own chat is admitted", async () => {
    expect(await admitSpendTurn({ sessionId: "mono-lead", cwd: HUB.folder, harness: "claude" })).toEqual({ ok: true });
  });

  it("a habit run of a non-Lead Mono works from home, so the project limit never applies to it", async () => {
    habits.add("habit-run-1");
    expect(await admitSpendTurn({ sessionId: "habit-run-1", cwd: "/Users/ash", harness: "claude" })).toEqual({ ok: true });
    habits.delete("habit-run-1");
  });
});

import { forgetSpendMemory, spendUnreadable, chatMayWrite, saveSpendLimit as save2 } from "./spendGate";

describe("C: unreadable storage at the one admission point", () => {
  it("a worker and a habit are admitted when the stored limits cannot be read (fails open)", async () => {
    localStorage.setItem("monocode:spend-limits", "{not json");
    forgetSpendMemory();
    expect(spendUnreadable()).toBe(true);
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
    expect(await admitSpendTurn({ sessionId: "app-mono-lead-r9", cwd: HUB.folder, harness: "claude" })).toEqual({ ok: true });
  });
});

describe("D: a first mate writes a limit for the same project under a different key", () => {
  it("existing person limit stored under the folder string is not 'existing' to a first mate writing the hub id", () => {
    // The person's limit is saved while the hub lookup does not know the folder yet (stored as the folder string).
    setSpendProjectLookup(null);
    expect(save2({ scope: "project", project: HUB.folder, period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" }).written).toBe(true);
    setSpendProjectLookup(lookup);
    const r = save2({ scope: "project", project: "hivra", period: "month", amountUsd: 999999, warnAt: 1 }, 1, { by: "first-mate" });
    expect(r.written).toBe(true);
    // both rows apply, so the stricter still binds
    setSpendSessions([row("chat", HUB.folder, 50)]);
    expect(judgeLaunch({ project: "hivra", harness: "claude" }).status).toBe("over");
    expect(chatMayWrite("first-mate", { scope: "project", project: "hivra", period: "month", amountUsd: 5, warnAt: 0.8 }, undefined).ok).toBe(true);
  });
});
