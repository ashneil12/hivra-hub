import { describe, expect, it } from "vitest";
import { boardChipCounts } from "./counts";
import { filterBoard, settledToday, type BoardFilter } from "./filter";
import { buildAgentsTree, flattenBoard, type BoardNode, type BoardPerson } from "./tree";

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

  it("each chip count equals the rows in that state under the project filter", () => {
    // Limit until PR #243: the chip recounts this board. It does not take a separate needs number.
    for (const projectId of [null, "hivra", "exo"] as const) {
      const counts = boardChipCounts(root, projectId, NOW);
      const rows = flattenBoard(filterBoard(root, { projectId, state: null }, NOW));
      expect(counts.needsYou).toBe(rows.filter((node) => node.state === "needs-you").length);
      expect(counts.working).toBe(rows.filter((node) => node.state === "working").length);
      expect(counts.doneToday).toBe(rows.filter((node) => doneToday(node)).length);
    }
    const all = boardChipCounts(root, null, NOW);
    const hivra = boardChipCounts(root, "hivra", NOW);
    expect(all.doneToday).toBe(1);
    expect(hivra.needsYou).toBe(all.needsYou);
    expect(hivra.working).toBe(0);
    expect(hivra.doneToday).toBe(0);
  });
});

function doneToday(node: BoardNode): boolean {
  return node.state === "done" && settledToday(node.settledAt, NOW);
}
