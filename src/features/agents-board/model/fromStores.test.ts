import { afterEach, describe, expect, it } from "vitest";
import { boardFromStores, mateStatus } from "./fromStores";
import { costUsdBySession } from "./cost";
import { setAgentsBoardSessionStop } from "./sessionStop";
import { flattenBoard } from "./tree";

afterEach(() => setAgentsBoardSessionStop(null));

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

describe("boardFromStores", () => {
  it("builds the tree from projects, captain sessions, first mates, delegations and sub-chats", () => {
    const board = boardFromStores({
      now: NOW,
      projects: [
        { id: "hivra", name: "Hivra", folder: "/Work/hivra" },
        { id: "exo", name: "EXO", folder: "/Work/exo" },
      ],
      sessions: [
        { id: "home-chat", place: "home", title: "Home", status: "working", task: "Morning brief", startedAt: NOW - 5 * 60_000 },
        {
          id: "hivra-chat",
          place: "project",
          projectId: "hivra",
          title: "/Work/hivra",
          status: "idle",
        },
        {
          id: "sub-chat",
          place: "subchat",
          parentSessionId: "worker-chat",
          title: "Read the test",
          status: "working",
          projectId: "hivra",
        },
      ],
      mates: [
        { id: "hivra-lead", name: "Hivra lead", projectId: "hivra", sessionId: "lead-chat", department: "coding", status: "working", task: "Ship the vault" },
        { id: "market", name: "Marketing", projectId: "hivra", department: "marketing", status: "paused" },
      ],
      delegations: [
        {
          id: "old",
          title: "Write the note",
          project: "hivra",
          ownerMono: "hivra-lead",
          childSession: "old-chat",
          status: "done",
          createdAt: NOW - 3_600_000,
          settledAt: NOW - 3_000_000,
        },
        {
          id: "new",
          title: "Fix the build",
          project: "/Work/hivra",
          ownerSession: "lead-chat",
          childSession: "worker-chat",
          status: "failed",
          createdAt: NOW - 10 * 60_000,
          startedAt: NOW - 10 * 60_000,
        },
      ],
      checks: [{ delegationId: "new", prNumber: 41, failing: 0, pending: 0, passed: true }],
      costs: [{ id: "worker-chat", blocks: [{ turnMetrics: { costUsd: 0.2 } }, { turnMetrics: { costUsd: 0.05 } }] }],
    });

    const ids = flattenBoard(board.tree).map((node) => node.id);
    expect(ids.filter((id) => id === "new")).toHaveLength(1);
    expect(ids).toContain("home-chat");
    expect(ids).toContain("hivra-chat");
    expect(ids).toContain("sub-chat");
    const hivra = board.tree.children.find((node) => node.projectId === "hivra");
    expect(hivra?.name).toBe("Hivra");
    expect(hivra?.children.map((node) => node.name)).toEqual(["Coding", "Marketing"]);
    expect(hivra?.children[0].children.map((node) => node.id)).toEqual(["new", "old"]);
    const job = flattenBoard(board.tree).find((node) => node.id === "new");
    expect(job?.name).toBe("Fix the build");
    expect(job?.state).toBe("needs-you");
    expect(job?.costLabel).toBe("$0.25");
    expect(job?.timeLabel).toBe("10 min");
    expect(job?.prNumber).toBe(41);
    expect(job?.checksLabel).toBe("checks green");
    expect(job?.children.map((node) => node.id)).toEqual(["sub-chat"]);
    expect(job?.rolledUp).toBe(false);
    expect(job?.canStop).toBe(false);
    expect(flattenBoard(board.tree).find((node) => node.id === "home-chat")?.canStop).toBe(false);
    expect(flattenBoard(board.tree).find((node) => node.id === "sub-chat")?.canStop).toBe(false);
    // Hivra and Coding only repeat this worker, so the chip stays 1. Home and the sub-chat are themselves working.
    expect(board.tree.rolledUp).toBe(true);
    expect(board.tree.state).toBe("needs-you");
    expect(board.counts).toEqual({ needsYou: 1, working: 2, doneToday: 1 });
    const text = JSON.stringify(flattenBoard(board.tree));
    expect(text).not.toMatch(/\bstuck\b/i);
    expect(text).not.toContain("/Work");
  });

  it("does not invent a home row, a cost or a pull request", () => {
    const board = boardFromStores({
      now: NOW,
      projects: [{ id: "exo", name: "EXO" }],
      sessions: [],
      mates: [],
      delegations: [{ id: "job", title: "Look", project: "exo", status: "working", createdAt: NOW }],
      checks: [],
      costs: [],
    });
    expect(board.tree.children.some((node) => node.role === "home")).toBe(false);
    const job = flattenBoard(board.tree).find((node) => node.id === "job");
    expect(job?.costLabel).toBeNull();
    expect(job?.prNumber).toBeNull();
    expect(job?.name).toBe("Look");
    expect(job?.canStop).toBe(false);
  });

  it("offers Stop on a working project chat or sub-chat only when the app Stop is registered", () => {
    const source = {
      now: NOW,
      projects: [{ id: "hivra", name: "Hivra" }],
      sessions: [
        { id: "home-chat", place: "home" as const, title: "Home", status: "idle" },
        { id: "hivra-chat", place: "project" as const, projectId: "hivra", title: "Hivra", status: "working" },
        { id: "sub-chat", place: "subchat" as const, parentSessionId: "worker-chat", projectId: "hivra", title: "Read", status: "working" },
      ],
      mates: [{ id: "lead", name: "Coding", projectId: "hivra", sessionId: "lead", department: "coding" }],
      delegations: [{ id: "job", title: "Fix", project: "hivra", ownerSession: "lead", childSession: "worker-chat", status: "working", createdAt: NOW }],
      checks: [],
      costs: [],
    };
    const before = boardFromStores(source);
    expect(flattenBoard(before.tree).find((node) => node.id === "hivra-chat")?.canStop).toBe(false);
    expect(flattenBoard(before.tree).find((node) => node.id === "sub-chat")?.canStop).toBe(false);
    setAgentsBoardSessionStop(() => undefined);
    const after = boardFromStores(source);
    expect(flattenBoard(after.tree).find((node) => node.id === "hivra-chat")?.canStop).toBe(true);
    expect(flattenBoard(after.tree).find((node) => node.id === "home-chat")?.canStop).toBe(false);
    expect(flattenBoard(after.tree).find((node) => node.id === "sub-chat")?.canStop).toBe(true);
    expect(flattenBoard(after.tree).find((node) => node.id === "job")?.canStop).toBe(true);
  });
});

describe("worker Stop", () => {
  it("is not offered on a failed or finished worker, and stays on work that is still going", () => {
    const board = boardFromStores({
      now: NOW,
      projects: [{ id: "hivra", name: "Hivra" }],
      sessions: [],
      mates: [{ id: "lead", name: "Coding", projectId: "hivra", sessionId: "lead-chat" }],
      delegations: [
        { id: "failed", title: "Broken", project: "hivra", ownerSession: "lead-chat", status: "failed", state: "running", createdAt: NOW },
        { id: "done", title: "Landed", project: "hivra", ownerSession: "lead-chat", status: "done", state: "running", createdAt: NOW },
        { id: "cancelled", title: "Dropped", project: "hivra", ownerSession: "lead-chat", state: "cancelled", createdAt: NOW },
        { id: "completed", title: "Finished", project: "hivra", ownerSession: "lead-chat", state: "completed", createdAt: NOW },
        { id: "halted", title: "Halted", project: "hivra", ownerSession: "lead-chat", state: "stopped", createdAt: NOW },
        { id: "old-fail", title: "Old", project: "hivra", ownerSession: "lead-chat", state: "failed", createdAt: NOW },
        { id: "live", title: "Going", project: "hivra", ownerSession: "lead-chat", status: "working", createdAt: NOW },
        { id: "ask", title: "Question", project: "hivra", ownerSession: "lead-chat", status: "needs-you", createdAt: NOW },
        { id: "question", title: "Ask", project: "hivra", ownerSession: "lead-chat", state: "question", createdAt: NOW },
        { id: "no-owner", title: "Loose", project: "hivra", status: "working", createdAt: NOW },
      ],
      checks: [],
      costs: [],
    });
    const stop = (id: string) => flattenBoard(board.tree).find((node) => node.id === id)?.canStop;
    expect(stop("failed")).toBe(false);
    expect(stop("done")).toBe(false);
    expect(stop("cancelled")).toBe(false);
    expect(stop("completed")).toBe(false);
    expect(stop("halted")).toBe(false);
    expect(stop("old-fail")).toBe(false);
    expect(stop("live")).toBe(true);
    expect(stop("ask")).toBe(true);
    expect(stop("question")).toBe(true);
    expect(stop("no-owner")).toBe(false);
    expect(flattenBoard(board.tree).find((node) => node.id === "failed")?.state).toBe("needs-you");
  });
});

describe("mateStatus", () => {
  it("is Working while the first mate's own chat runs a turn", () => {
    const sessions = [
      { id: "lead-chat", busy: true },
      { id: "other", busy: false },
    ];
    expect(mateStatus("lead-chat", sessions)).toBe("working");
    expect(mateStatus("other", sessions)).toBe("idle");
    expect(mateStatus("missing", sessions)).toBe("idle");
    expect(mateStatus(null, sessions)).toBe("idle");
  });
});

describe("costUsdBySession", () => {
  it("sums reported turn costs and skips a session that reported none", () => {
    const costs = costUsdBySession([
      { id: "a", blocks: [{ turnMetrics: { costUsd: 1 } }, { turnMetrics: { costUsd: -1 } }, { role: "user" }] },
      { id: "b", blocks: [{ turnMetrics: {} }] },
      { id: "", blocks: [{ turnMetrics: { costUsd: 4 } }] },
    ]);
    expect(costs.get("a")).toBe(1);
    expect(costs.has("b")).toBe(false);
    expect(costs.has("")).toBe(false);
  });
});
