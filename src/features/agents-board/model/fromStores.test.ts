import { describe, expect, it } from "vitest";
import { boardFromStores } from "./fromStores";
import { costUsdBySession } from "./cost";
import { flattenBoard } from "./tree";

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
