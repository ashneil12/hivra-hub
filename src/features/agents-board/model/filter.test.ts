import { describe, expect, it } from "vitest";
import { boardChipCounts } from "./counts";
import { filterBoard, settledToday, type BoardFilter } from "./filter";
import { buildAgentsTree, flattenBoard, type BoardNode, type BoardPerson, type BoardState } from "./tree";

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

function person(patch: Partial<BoardPerson> & Pick<BoardPerson, "id" | "role">): BoardPerson {
  return { name: patch.name ?? patch.id, state: "idle", ...patch };
}

const root = buildAgentsTree({
  now: NOW,
  projects: [
    { id: "hivra", name: "Hivra" },
    { id: "exo", name: "EXO" },
  ],
  people: [
    person({ id: "captain", role: "captain", name: "Chief of Staff" }),
    person({ id: "home", role: "home", name: "Home", state: "working" }),
    person({ id: "hivra-session", role: "project", projectId: "hivra", name: "Hivra" }),
    person({ id: "exo-session", role: "project", projectId: "exo", name: "EXO" }),
    person({ id: "coding", role: "mate", projectId: "hivra", name: "Coding", department: "coding", state: "working" }),
    person({
      id: "need",
      role: "worker",
      projectId: "hivra",
      parentId: "coding",
      name: "Needs a decision",
      state: "needs-you",
    }),
    person({
      id: "today",
      role: "worker",
      projectId: "exo",
      name: "Shipped",
      state: "done",
      settledAt: NOW - 60_000,
    }),
    person({
      id: "yesterday",
      role: "worker",
      projectId: "exo",
      name: "Old ship",
      state: "done",
      settledAt: NOW - 26 * 3_600_000,
    }),
  ],
});

function ids(filter: BoardFilter): string[] {
  return flattenBoard(filterBoard(root, filter, NOW)).map((node) => node.id);
}

describe("filterBoard", () => {
  it("keeps a project branch and the captain, and drops the other project and home", () => {
    expect(ids({ projectId: "hivra", state: null })).toEqual(["captain", "hivra-session", "coding", "need"]);
  });

  it("filters by needs you, working, and done today", () => {
    expect(ids({ projectId: null, state: "needs-you" })).toEqual(["captain", "hivra-session", "coding", "need"]);
    expect(ids({ projectId: null, state: "working" })).toContain("home");
    expect(ids({ projectId: null, state: "working" })).not.toContain("coding");
    expect(ids({ projectId: null, state: "working" })).not.toContain("need");
    expect(ids({ projectId: null, state: "done-today" })).toContain("today");
    expect(ids({ projectId: null, state: "done-today" })).not.toContain("yesterday");
  });

  it("each chip equals the rows that are themselves in that state, not a rolled-up parent", () => {
    // A parent whose chip only repeats a child does not count. That is the same set WP-210 counts.
    for (const projectId of [null, "hivra", "exo"] as const) {
      const counts = boardChipCounts(root, projectId, NOW);
      const rows = flattenBoard(filterBoard(root, { projectId, state: null }, NOW));
      expect(counts.needsYou).toBe(rows.filter((node) => itself(node, "needs-you")).length);
      expect(counts.working).toBe(rows.filter((node) => itself(node, "working")).length);
      expect(counts.doneToday).toBe(rows.filter((node) => itselfDoneToday(node)).length);
    }
    const all = boardChipCounts(root, null, NOW);
    const hivra = boardChipCounts(root, "hivra", NOW);
    expect(all.needsYou).toBe(1);
    expect(all.working).toBe(1);
    expect(all.doneToday).toBe(1);
    expect(hivra.needsYou).toBe(1);
    expect(hivra.working).toBe(0);
    expect(hivra.doneToday).toBe(0);
  });

  it("still counts a row that is itself in the state when a child is too", () => {
    const counted = buildAgentsTree({
      now: NOW,
      projects: [
        { id: "hivra", name: "Hivra" },
        { id: "exo", name: "EXO" },
      ],
      people: [
        person({ id: "captain", role: "captain", name: "Chief of Staff", state: "working" }),
        person({ id: "home", role: "home", name: "Home", state: "working" }),
        person({ id: "hivra-session", role: "project", projectId: "hivra", name: "Hivra", state: "idle" }),
        person({ id: "coding", role: "mate", projectId: "hivra", name: "Coding", department: "coding", state: "needs-you" }),
        person({ id: "need", role: "worker", projectId: "hivra", parentId: "coding", name: "Need", state: "needs-you" }),
        person({ id: "exo-session", role: "project", projectId: "exo", name: "EXO", state: "idle" }),
        person({ id: "run", role: "worker", projectId: "exo", name: "Run", state: "working" }),
      ],
    });
    expect(flattenBoard(counted).find((node) => node.id === "coding")?.rolledUp).toBe(false);
    expect(boardChipCounts(counted, null, NOW)).toEqual({ needsYou: 2, working: 2, doneToday: 0 });
    expect(boardChipCounts(counted, "hivra", NOW)).toEqual({ needsYou: 2, working: 0, doneToday: 0 });
    expect(boardChipCounts(counted, "exo", NOW)).toEqual({ needsYou: 0, working: 1, doneToday: 0 });
  });
});

function itself(node: BoardNode, state: BoardState): boolean {
  return !node.rolledUp && node.state === state;
}

function itselfDoneToday(node: BoardNode): boolean {
  return itself(node, "done") && settledToday(node.settledAt, NOW);
}
