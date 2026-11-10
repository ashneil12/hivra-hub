import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { crewTree, type CrewTreeNode, type CrewTreeSession } from "./crewTree";
import type { CrewWorkerInput } from "./rows";

const NOW = 1_700_000_000_000;
const PROJECT = "/work/proj";

function worker(patch: Partial<CrewWorkerInput> & { id: string }): CrewWorkerInput {
  return {
    project: PROJECT,
    title: patch.id,
    status: "working",
    createdAt: 1,
    updatedAt: 1,
    ownerSession: "lead",
    ...patch,
  };
}

function mate(blocks: unknown[] = [], patch: Partial<CrewTreeSession> = {}): CrewTreeSession {
  return { id: "lead", title: "Lead", cwd: PROJECT, firstMate: true, blocks, ...patch };
}

function readTool(id: string, status: string, startedAt: number, updatedAt = startedAt): Block {
  return {
    id,
    role: "tool",
    text: "Read notes",
    tool: { kind: "read", title: "Read notes", status, startedAt, updatedAt },
  };
}

function names(node: CrewTreeNode | null | undefined): string[] {
  if (!node) return [];
  return [node.id, ...node.children.flatMap((child) => names(child))];
}

describe("crew tree", () => {
  it("puts the first mate at the root and one child per worker, oldest first", () => {
    const tree = crewTree({
      project: `${PROJECT}/`,
      now: NOW,
      sessions: [mate([{ id: "ask", role: "user", text: "Fix the save" }])],
      workers: [
        worker({ id: "b", title: "Write the note", createdAt: 2, childSession: "chat-b" }),
        worker({ id: "a", title: "Fix the save", createdAt: 1, childSession: "chat-a", brief: "Stop the crash" }),
      ],
    });
    expect(tree.root).toMatchObject({
      id: "mate:lead",
      role: "mate",
      title: "Lead",
      sessionId: "lead",
      brief: "Fix the save",
    });
    expect(tree.root?.children.map((child) => child.id)).toEqual(["a", "b"]);
    expect(tree.root?.children[0]).toMatchObject({ role: "worker", title: "Fix the save", brief: "Stop the crash", sessionId: "chat-a" });
  });

  it("nests a recorded subagent under the worker that spawned it, and shows the tool call while it works", () => {
    const subagent: Block = {
      id: "sub1",
      role: "tool",
      text: "Check the save",
      tool: { kind: "agent", title: "Check the save", status: "running", startedAt: NOW - 2_000 },
      agentRun: {
        name: "Check the save",
        steps: [
          { id: "s1", kind: "tool", text: "Read the file", toolKind: "read", status: "running" },
          { id: "s2", kind: "tool", text: "agent Review the diff", toolKind: "agent", status: "running" },
        ],
      },
    };
    const tree = crewTree({
      project: PROJECT,
      now: NOW,
      sessions: [
        mate(),
        { id: "chat-a", cwd: "/tmp/worktree with spaces", blocks: [subagent] },
        { id: "chat-b", cwd: "/elsewhere", blocks: [readTool("t1", "running", NOW - 4_000)] },
      ],
      workers: [
        worker({ id: "a", title: "Fix the save", childSession: "chat-a", createdAt: 1 }),
        worker({ id: "b", title: "Write the note", childSession: "chat-b", createdAt: 2 }),
      ],
    });
    const fixer = tree.root?.children.find((child) => child.id === "a");
    const writer = tree.root?.children.find((child) => child.id === "b");
    expect(fixer?.children.map((child) => child.id)).toEqual(["subagent:chat-a:sub1"]);
    expect(fixer?.children[0]).toMatchObject({
      role: "subagent",
      title: "Check the save",
      sessionId: "chat-a",
      brief: "Check the save",
      statusWord: "working",
      latestTool: "Read the file",
    });
    expect(fixer?.children[0]?.tools[0]).toMatchObject({ label: "Read the file", running: true, timing: null });
    expect(fixer?.children[0]?.children[0]).toMatchObject({ role: "subagent", title: "Review the diff", statusWord: "working" });
    expect(fixer?.latestTool).toBe("Check the save");
    expect(writer?.latestTool).toBe("Read notes");
    expect(writer?.tools[0]).toMatchObject({ label: "Read notes", running: true, timing: "4 seconds" });
    expect(names(tree.root).filter((id) => id.startsWith("subagent:"))).toEqual(["subagent:chat-a:sub1"]);
  });

  it("keeps a finished tool on the detail and off the row, and skips a hidden call", () => {
    const tree = crewTree({
      project: PROJECT,
      now: NOW,
      sessions: [
        mate(),
        {
          id: "chat-a",
          blocks: [
            readTool("t1", "completed", NOW - 125_000, NOW - 5_000),
            { id: "todo", role: "tool", text: "tasks", tool: { kind: "tasks", title: "tasks", status: "running" } },
          ],
        },
      ],
      workers: [worker({ id: "a", status: "done", childSession: "chat-a", statusNotice: "sk-live-secret" })],
    });
    const row = tree.root?.children[0];
    expect(row?.statusWord).toBe("done");
    expect(row?.latestTool).toBeNull();
    expect(row?.tools).toEqual([
      { id: "t1", label: "Read notes", running: false, timing: "2 minutes" },
    ]);
  });

  it("uses the crew status when a worker is going and the chat has no tool call yet", () => {
    const tree = crewTree({
      project: PROJECT,
      now: NOW,
      sessions: [mate()],
      workers: [
        worker({ id: "a", statusNotice: "Reading the notes" }),
        worker({ id: "b", createdAt: 2, statusNotice: "sk-live-secret" }),
      ],
    });
    expect(tree.root?.children[0]?.latestTool).toBe("Reading the notes");
    expect(tree.root?.children[1]?.latestTool).toBeNull();
  });

  it("is an empty tree when nothing is recorded, and a first mate alone when the crew is empty", () => {
    expect(crewTree({ project: "", now: NOW, workers: [worker({ id: "a" })] }).root).toBeNull();
    expect(crewTree({ project: "~", now: NOW }).root).toBeNull();
    expect(crewTree({ project: PROJECT, now: NOW }).root).toBeNull();
    expect(crewTree({ project: PROJECT, workers: [], sessions: [], now: NOW }).root).toBeNull();
    const alone = crewTree({
      project: PROJECT,
      now: NOW,
      sessions: [mate()],
    });
    expect(alone.root).toMatchObject({ id: "mate:lead", title: "Lead", children: [] });
  });

  it("does not throw on missing, duplicate, or junk records, and drops another project", () => {
    const tree = crewTree({
      project: "C:/work/proj",
      now: Number.NaN,
      workers: [
        null as unknown as CrewWorkerInput,
        worker({ id: "  ", project: "C:/work/proj" }),
        worker({ id: "a", project: "c:\\work\\proj\\", title: "Old", updatedAt: 1, brief: "First brief" }),
        worker({ id: "a", project: "C:/work/proj", title: "New — name", updatedAt: 2, brief: "10—20 files" }),
        worker({ id: "lead-row", project: "C:/work/proj", follow: "lead", title: "The lead" }),
        worker({ id: "away", project: "/elsewhere", title: "Not here" }),
        worker({ id: "dot", project: "C:/work/proj/../proj", title: "Not the same path" }),
      ],
      sessions: [
        null as unknown as CrewTreeSession,
        { id: "lead", title: "Old mate", cwd: "C:/work/proj", firstMate: true, blocks: [] },
        {
          id: "lead",
          title: "Mate — one",
          cwd: "c:\\work\\proj",
          firstMate: true,
          blocks: [null, "nope", { id: 1 }, { no: "role" }, { id: "ask", role: "user", text: "Ship — it\r\nnext" }],
        },
      ],
    });
    expect(tree.root).toMatchObject({ title: "Mate, one", brief: "Ship, it" });
    expect(tree.root?.children.map((child) => child.id)).toEqual(["a"]);
    expect(tree.root?.children[0]).toMatchObject({ title: "New, name", brief: "10-20 files" });
  });

  it("hangs a worker on its parent, and breaks a cycle by putting both on the mate", () => {
    const chain = crewTree({
      project: PROJECT,
      now: NOW,
      sessions: [mate()],
      workers: [
        worker({ id: "child", parentId: "parent", createdAt: 2, ownerSession: "lead" }),
        worker({ id: "parent", parentId: "missing", createdAt: 1, ownerSession: "lead" }),
        worker({ id: "lead-row", follow: "lead", parentId: null }),
      ],
    });
    expect(chain.root?.children.map((child) => child.id)).toEqual(["parent"]);
    expect(chain.root?.children[0]?.children.map((child) => child.id)).toEqual(["child"]);

    const cycle = crewTree({
      project: PROJECT,
      now: NOW,
      sessions: [mate()],
      workers: [
        worker({ id: "a", parentId: "b" }),
        worker({ id: "b", parentId: "a" }),
        worker({ id: "c", parentId: "c" }),
      ],
    });
    expect(cycle.root?.children.map((child) => child.id).sort()).toEqual(["a", "b", "c"]);
    expect(cycle.root?.children.every((child) => child.children.length === 0)).toBe(true);
  });

  it("nests a workflow's agents under the chat that launched them", () => {
    const tree = crewTree({
      project: PROJECT,
      now: NOW,
      sessions: [
        mate([
          {
            id: "run",
            role: "tool",
            text: "Review the change",
            tool: { kind: "workflow", title: "Review the change", status: "running", startedAt: NOW - 1_000 },
            workflowRun: {
              taskId: "run",
              status: "running",
              phases: [],
              agents: [
                { index: 0, label: "Read the diff", state: "done", durationMs: 2_000, prompt: "Look at the save" },
                { index: 1, label: "Try the save", state: "working" },
              ],
            },
          },
        ]),
      ],
    });
    const run = tree.root?.children[0];
    expect(run).toMatchObject({ role: "subagent", title: "Review the change", statusWord: "working" });
    expect(run?.children.map((child) => child.title)).toEqual(["Read the diff", "Try the save"]);
    expect(run?.children[0]?.tools[0]).toMatchObject({ timing: "2 seconds" });
    expect(tree.root?.latestTool).toBe("Review the change");
  });

  it("still shows the workers when no first mate chat is open", () => {
    const tree = crewTree({
      project: PROJECT,
      now: NOW,
      workers: [worker({ id: "a", title: "Fix the save", ownerSession: null, brief: "Stop the crash" })],
    });
    expect(tree.root).toMatchObject({ title: "First mate", sessionId: null, children: [{ id: "a", brief: "Stop the crash" }] });
  });
});
