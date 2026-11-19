import { describe, expect, it } from "vitest";
import { buildAgentsTree, descendantOwnCount, flattenBoard, type BoardPerson, type BoardProject } from "./tree";
import { rollupText } from "./words";

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

const PROJECTS: BoardProject[] = [
  { id: "hivra", name: "Hivra", folder: "/Work/hivra" },
  { id: "exo", name: "EXO", folder: "/Work/exo" },
];

function person(patch: Partial<BoardPerson> & Pick<BoardPerson, "id" | "role">): BoardPerson {
  return { name: patch.id, state: "idle", ...patch };
}

function tree(people: BoardPerson[], projects: BoardProject[] = PROJECTS) {
  return buildAgentsTree({ projects, people, now: NOW });
}

describe("buildAgentsTree", () => {
  it("nests the captain, its home and project sessions, coding first, then crew and sub-chats", () => {
    const root = tree([
      person({ id: "captain", role: "captain", name: "Chief of Staff", state: "working" }),
      person({ id: "home", role: "home", name: "Home", parentId: "captain", state: "working", task: "Morning brief" }),
      person({
        id: "hivra-session",
        role: "project",
        name: "/Work/hivra",
        projectId: "hivra",
        parentId: "captain",
        state: "idle",
      }),
      person({
        id: "exo-session",
        role: "project",
        name: "C:\\Work\\exo",
        projectId: "exo",
        parentId: "captain",
        state: "idle",
      }),
      person({
        id: "marketing",
        role: "mate",
        name: "Marketing",
        projectId: "hivra",
        department: "marketing",
        state: "idle",
      }),
      person({
        id: "coding",
        role: "mate",
        name: "hivra-lead",
        projectId: "hivra",
        department: "coding",
        state: "working",
        task: "Ship the vault",
      }),
      person({
        id: "older",
        role: "worker",
        name: "Older job",
        projectId: "hivra",
        parentId: "coding",
        state: "done",
        createdAt: NOW - 3_600_000,
        settledAt: NOW - 60_000,
      }),
      person({
        id: "newer",
        role: "worker",
        name: "Newer job",
        projectId: "hivra",
        parentId: "coding",
        state: "needs-you",
        createdAt: NOW - 60_000,
        task: "A test is stuck on Windows",
        costUsd: 1.5,
        startedAt: NOW - 20 * 60_000,
        prNumber: 217,
        checks: { failing: 3, pending: 0, passed: false },
        canStop: true,
        sessionId: "chat-newer",
      }),
      person({
        id: "sub",
        role: "subchat",
        name: "Look at the test",
        projectId: "hivra",
        parentId: "newer",
        state: "working",
        sessionId: "chat-sub",
      }),
    ]);

    expect(root.role).toBe("captain");
    expect(root.name).toBe("Chief of Staff");
    expect(root.children.map((child) => child.id)).toEqual(["home", "hivra-session", "exo-session"]);
    const hivra = root.children[1];
    expect(hivra.name).toBe("Hivra");
    expect(hivra.name).not.toContain("/");
    expect(root.children[2].name).toBe("EXO");
    expect(root.children[2].name).not.toContain("\\");
    expect(hivra.children.map((child) => child.id)).toEqual(["coding", "marketing"]);
    expect(hivra.children[0].name).toBe("Coding");
    const crew = hivra.children[0].children;
    expect(crew.map((child) => child.id)).toEqual(["newer", "older"]);
    expect(crew[0].children.map((child) => child.id)).toEqual(["sub"]);
    expect(crew[0].task).toBe("A test is stopped on Windows");
    expect(crew[0].costLabel).toBe("$1.50");
    expect(crew[0].timeLabel).toBe("20 min");
    expect(crew[0].prNumber).toBe(217);
    expect(crew[0].checksLabel).toBe("3 checks failing");
    expect(flattenBoard(root).map((node) => node.id)).toEqual([
      "captain",
      "home",
      "hivra-session",
      "coding",
      "newer",
      "sub",
      "older",
      "marketing",
      "exo-session",
    ]);
  });

  it("keeps a worker with no project or owner on the board, under the Chief of Staff", () => {
    // A global Mono's job, or one whose folder is not a listed project, has nowhere else to go. It is not dropped.
    const root = tree([
      person({ id: "captain", role: "captain", name: "Chief of Staff" }),
      person({ id: "loose", role: "worker", name: "Loose job", projectId: null, parentId: null, state: "needs-you", sessionId: "loose-chat" }),
      person({ id: "loose-sub", role: "subchat", name: "Its sub-chat", parentId: "loose-chat", state: "working", sessionId: "loose-sub-chat" }),
      person({ id: "job", role: "worker", name: "Job", projectId: "hivra", parentId: "gone", state: "working" }),
    ]);
    const loose = root.children.find((node) => node.id === "loose");
    expect(loose?.state).toBe("needs-you");
    expect(loose?.children.map((node) => node.id)).toEqual(["loose-sub"]);
    expect(root.children.find((node) => node.projectId === "hivra")?.children.map((node) => node.id)).toEqual(["job"]);
    expect(root.state).toBe("needs-you");
    const ids = flattenBoard(root).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists a person once when the same id or session arrives twice", () => {
    const root = tree([
      person({ id: "captain", role: "captain", name: "Chief of Staff" }),
      person({ id: "coding", role: "mate", name: "Coding", projectId: "hivra", department: "coding", sessionId: "lead-chat" }),
      person({ id: "coding", role: "worker", name: "Coding again", projectId: "hivra", parentId: "coding", sessionId: "lead-chat" }),
      person({ id: "job", role: "worker", name: "Job", projectId: "hivra", parentId: "coding", sessionId: "job-chat" }),
      person({ id: "job-again", role: "subchat", name: "Same chat", projectId: "hivra", parentId: "job", sessionId: "job-chat" }),
    ]);
    const ids = flattenBoard(root).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sessions = flattenBoard(root).map((node) => node.sessionId).filter(Boolean);
    expect(new Set(sessions).size).toBe(sessions.length);
    expect(ids).not.toContain("job-again");
    expect(flattenBoard(root).find((node) => node.id === "coding")?.role).toBe("mate");
  });

  it("leaves cost, time and checks out when the source did not report them", () => {
    const root = tree([
      person({ id: "captain", role: "captain", name: "Chief of Staff" }),
      person({ id: "job", role: "worker", name: "Quiet job", projectId: "hivra", parentId: "missing-mate", state: "working" }),
    ]);
    const job = flattenBoard(root).find((node) => node.id === "job");
    expect(job?.costLabel).toBeNull();
    expect(job?.timeLabel).toBeNull();
    expect(job?.checksLabel).toBeNull();
    expect(job?.prNumber).toBeNull();
  });

  it("never shows a path, a raw id, or the word stuck", () => {
    const root = tree([
      person({ id: "captain", role: "captain", name: "chief-of-staff" }),
      person({
        id: "job",
        role: "worker",
        name: "/tmp/hivra/job",
        projectId: "hivra",
        state: "needs-you",
        task: "Worker is Stuck",
      }),
    ]);
    const text = flattenBoard(root)
      .flatMap((node) => [node.name, node.task, node.checksLabel, node.costLabel, node.timeLabel])
      .filter(Boolean)
      .join("\n");
    expect(text).not.toMatch(/\bstuck\b/i);
    expect(text).not.toContain("/");
    expect(text).not.toContain("chief-of-staff");
    expect(text).not.toMatch(/[—–]/);
    expect(root.name).toBe("Chief of Staff");
    expect(flattenBoard(root).find((node) => node.id === "job")?.name).toBe("Hivra");
  });

  it("says checks green only when the checks passed, and a stopped worker is Needs you", () => {
    const root = tree([
      person({ id: "captain", role: "captain", name: "Chief of Staff" }),
      person({
        id: "green",
        role: "worker",
        name: "Green job",
        projectId: "exo",
        state: "done",
        prNumber: 12,
        checks: { failing: 0, pending: 0, passed: true },
      }),
      person({
        id: "stopped",
        role: "worker",
        name: "Stopped job",
        projectId: "exo",
        state: "needs-you",
        prNumber: 0,
        checks: { failing: 1, pending: 2, passed: false },
      }),
    ]);
    const green = flattenBoard(root).find((node) => node.id === "green");
    const stopped = flattenBoard(root).find((node) => node.id === "stopped");
    expect(green?.checksLabel).toBe("checks green");
    expect(green?.prNumber).toBe(12);
    expect(stopped?.state).toBe("needs-you");
    expect(stopped?.checksLabel).toBe("1 check failing");
    expect(stopped?.prNumber).toBeNull();
  });

  it("rolls every level, the top included, to Needs you, else Working, else Done or Idle", () => {
    const root = tree(
      [
        person({ id: "captain", role: "captain", name: "Chief of Staff", state: "idle" }),
        person({ id: "hivra-session", role: "project", name: "Hivra", projectId: "hivra", state: "idle" }),
        person({
          id: "coding",
          role: "mate",
          name: "Coding",
          projectId: "hivra",
          department: "coding",
          state: "working",
        }),
        person({
          id: "need",
          role: "worker",
          name: "Need",
          projectId: "hivra",
          parentId: "coding",
          state: "needs-you",
        }),
        person({
          id: "sub",
          role: "subchat",
          name: "Sub",
          projectId: "hivra",
          parentId: "need",
          state: "working",
        }),
        person({
          id: "marketing",
          role: "mate",
          name: "Marketing",
          projectId: "hivra",
          department: "marketing",
          state: "idle",
        }),
        person({ id: "exo-session", role: "project", name: "EXO", projectId: "exo", state: "idle" }),
        person({ id: "shipped", role: "worker", name: "Shipped", projectId: "exo", state: "done" }),
        person({ id: "quiet-session", role: "project", name: "Quiet", projectId: "quiet", state: "idle" }),
        person({ id: "ops", role: "mate", name: "Ops", projectId: "quiet", department: "ops", state: "idle" }),
        person({
          id: "busy",
          role: "mate",
          name: "Busy",
          projectId: "quiet",
          department: "coding",
          state: "done",
        }),
        person({
          id: "running",
          role: "worker",
          name: "Running",
          projectId: "quiet",
          parentId: "busy",
          state: "working",
        }),
      ],
      [
        { id: "hivra", name: "Hivra" },
        { id: "exo", name: "EXO" },
        { id: "quiet", name: "Quiet" },
      ],
    );
    const nodeOf = (id: string) => flattenBoard(root).find((node) => node.id === id);
    expect(nodeOf("captain")?.state).toBe("needs-you");
    expect(nodeOf("captain")?.rolledUp).toBe(true);
    expect(descendantOwnCount(nodeOf("captain")!, "needs-you")).toBe(1);
    expect(rollupText(1, "needs-you")).toBe("1 needs you below");
    expect(rollupText(2, "needs-you")).toBe("2 need you below");
    expect(rollupText(2, "working")).toBe("2 working");
    expect(rollupText(0, "working")).toBeNull();
    expect(nodeOf("hivra-session")?.state).toBe("needs-you");
    expect(nodeOf("hivra-session")?.rolledUp).toBe(true);
    expect(nodeOf("coding")?.state).toBe("needs-you");
    expect(nodeOf("coding")?.rolledUp).toBe(true);
    expect(nodeOf("need")?.state).toBe("needs-you");
    expect(nodeOf("need")?.rolledUp).toBe(false);
    expect(nodeOf("sub")?.state).toBe("working");
    expect(nodeOf("sub")?.rolledUp).toBe(false);
    expect(nodeOf("marketing")?.state).toBe("idle");
    expect(nodeOf("marketing")?.rolledUp).toBe(false);
    expect(nodeOf("exo-session")?.state).toBe("done");
    expect(nodeOf("exo-session")?.rolledUp).toBe(true);
    expect(nodeOf("shipped")?.state).toBe("done");
    expect(nodeOf("shipped")?.rolledUp).toBe(false);
    expect(nodeOf("busy")?.state).toBe("working");
    expect(nodeOf("busy")?.rolledUp).toBe(true);
    expect(nodeOf("quiet-session")?.state).toBe("working");
    expect(nodeOf("quiet-session")?.rolledUp).toBe(true);
    expect(nodeOf("ops")?.state).toBe("idle");
    expect(nodeOf("ops")?.rolledUp).toBe(false);
  });

  it("rolls a worker up from its sub-chat the same way as the top row", () => {
    const root = tree([
      person({ id: "captain", role: "captain", name: "Chief of Staff", state: "working" }),
      person({ id: "hivra-session", role: "project", name: "Hivra", projectId: "hivra", state: "idle" }),
      person({ id: "coding", role: "mate", name: "Coding", projectId: "hivra", department: "coding", state: "idle" }),
      person({
        id: "job",
        role: "worker",
        name: "Job",
        projectId: "hivra",
        parentId: "coding",
        state: "working",
      }),
      person({
        id: "ask",
        role: "subchat",
        name: "Ask",
        projectId: "hivra",
        parentId: "job",
        state: "needs-you",
      }),
    ]);
    const nodeOf = (id: string) => flattenBoard(root).find((node) => node.id === id);
    for (const id of ["captain", "hivra-session", "coding", "job"]) {
      expect(nodeOf(id)?.state).toBe("needs-you");
      expect(nodeOf(id)?.rolledUp).toBe(true);
    }
    expect(nodeOf("ask")?.state).toBe("needs-you");
    expect(nodeOf("ask")?.rolledUp).toBe(false);
  });
});
