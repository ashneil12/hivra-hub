import { describe, expect, it } from "vitest";
import {
  cleanWorkTitle,
  formatLiveElapsed,
  liveAgentsFromSessions,
} from "./liveAgents";
import { newSession, type Block, type Session } from "./session";

function chat(cwd: string, patch: Partial<Session> = {}): Session {
  const session = newSession("claude", cwd);
  session.title = "claude · Fix the sidebar";
  session.blocks = [{ id: "u1", role: "user", text: "hello", startedAt: 1_000 }];
  return { ...session, ...patch, blocks: patch.blocks ?? session.blocks };
}

function edit(id: string, path = "src/App.tsx", status = "in_progress"): Block {
  const fileName = path.split("/").pop() ?? path;
  return {
    id,
    role: "tool",
    text: `Edited ${path}`,
    tool: {
      kind: "edit",
      title: `Edited ${path}`,
      status,
      preview: { kind: "write", path, fileName },
    },
  };
}

describe("liveAgentsFromSessions", () => {
  it("excludes Mono activity while keeping regular working and finished sessions", () => {
    const working = chat("/repo", { id: "working", busy: true });
    const done = chat("/repo", { id: "done" });
    const monoWorking = chat("~", { id: "mono-working", busy: true });
    const monoWaiting = chat("~", {
      id: "mono-waiting",
      blocks: [{
        id: "approval",
        role: "approval",
        text: "Run a command",
        approval: { requestId: 1 },
      }],
    });
    const monoDone = chat("~", { id: "mono-done" });
    const agents = liveAgentsFromSessions(
      [monoWaiting, monoWorking, monoDone, done, working],
      new Set([monoDone.id, done.id]),
      new Set([monoWorking.id, monoWaiting.id, monoDone.id]),
    );
    expect(agents.map((agent) => agent.id)).toEqual([working.id, done.id]);
    expect(agents[1].done).toBe(true);
    // The Hub's tray lists only running work: a finished job there read as still going (Ash, 20 Oct baseline).
    const running = liveAgentsFromSessions(
      [monoWaiting, monoWorking, monoDone, done, working],
      new Set([monoDone.id, done.id]),
      new Set([monoWorking.id, monoWaiting.id, monoDone.id]),
      { runningOnly: true },
    );
    expect(running.map((agent) => agent.id)).toEqual([working.id]);
  });

  it("names a delegated worker by its task title, never the brief's '[MonoCode brief from …]' first line", () => {
    const brief = "[MonoCode brief from Chief of Staff]\n\nAsh said: \"hold on. make it work fully\". Reading the code, I think both already work.";
    const worker = chat("/repo", { id: "worker", busy: true, title: `claude · ${brief}` });
    const taskTitle = (id: string) => (id === "worker" ? "Prove delete end to end, then review" : undefined);
    expect(liveAgentsFromSessions([worker], new Set(), new Set(), { taskTitle })[0].title).toBe(
      "Prove delete end to end, then review",
    );
    // No task row for it (a plain sessions.start): the header goes and the brief's words remain, without the quote
    // opener (r65, PM's r63 run: a title read "Ash's words, verbatim: …").
    expect(liveAgentsFromSessions([worker])[0].title).toBe('"hold on. make it work fully". Reading the code, I think both already work.');
    expect(cleanWorkTitle("[MonoCode brief from Chief of Staff]")).toBe("Delegated work");
    expect(cleanWorkTitle("Fix the sidebar")).toBe("Fix the sidebar");
  });

  it("keeps internal workers in their lead's agent panel", () => {
    const lead = chat("/repo", { id: "lead", busy: true });
    const worker = chat("/repo", { id: "worker", busy: true, orchestrationLeadId: "lead" });
    expect(liveAgentsFromSessions([lead, worker]).map((agent) => agent.id)).toEqual(["lead"]);
  });
  it("skips idle sessions", () => {
    expect(liveAgentsFromSessions([chat("/tmp/a")])).toEqual([]);
  });

  it("maps a busy turn into a live agent", () => {
    const session = chat("/tmp/agent-terminal", {
      busy: true,
      blocks: [
        { id: "u1", role: "user", text: "hello", startedAt: 1_000 },
        edit("t1"),
      ],
    });
    expect(liveAgentsFromSessions([session])).toEqual([
      {
        id: session.id,
        cwd: "/tmp/agent-terminal",
        title: "Fix the sidebar",
        harness: "claude",
        activity: "Editing App.tsx",
        startedAt: 1_000,
        durationMs: undefined,
        needsApproval: false,
        done: false,
      },
    ]);
  });

  it("puts sessions waiting on approval first", () => {
    const working = chat("/tmp/a", {
      busy: true,
      blocks: [
        { id: "u1", role: "user", text: "go", startedAt: 1_000 },
        edit("t1"),
      ],
    });
    const waiting = chat("/tmp/b", {
      busy: true,
      blocks: [
        { id: "u1", role: "user", text: "go", startedAt: 2_000 },
        {
          id: "a1",
          role: "approval",
          text: "run rm",
          approval: { requestId: 1 },
        },
      ],
    });
    expect(liveAgentsFromSessions([working, waiting]).map((row) => row.id)).toEqual(
      [waiting.id, working.id],
    );
    expect(liveAgentsFromSessions([working, waiting])[0]?.needsApproval).toBe(
      true,
    );
  });

  it("treats a parked clarifying question as needing approval", () => {
    const waiting = chat("/tmp/ask", {
      busy: true,
      pendingQuestion: {
        requestId: 4,
        title: "Which file?",
        questions: [
          {
            id: "q1",
            prompt: "Which file?",
            multiSelect: false,
            allowCustom: true,
            options: [{ id: "a.ts", label: "a.ts" }],
          },
        ],
      },
    });
    expect(liveAgentsFromSessions([waiting])[0]).toMatchObject({
      id: waiting.id,
      activity: "Which file?",
      needsApproval: true,
      done: false,
    });
  });

  it("sorts working agents by longest-running turn first", () => {
    const newer = chat("/tmp/new", {
      busy: true,
      blocks: [{ id: "u1", role: "user", text: "go", startedAt: 5_000 }],
    });
    const older = chat("/tmp/old", {
      busy: true,
      blocks: [{ id: "u1", role: "user", text: "go", startedAt: 1_000 }],
    });
    expect(liveAgentsFromSessions([newer, older]).map((row) => row.cwd)).toEqual(
      ["/tmp/old", "/tmp/new"],
    );
  });

  it("keeps an unfocused finished session until it is seen", () => {
    const finished = chat("/tmp/done", {
      blocks: [
        {
          id: "u1",
          role: "user",
          text: "go",
          startedAt: 1_000,
          durationMs: 12_000,
        },
        edit("t1", "src/App.tsx", "completed"),
      ],
    });
    expect(liveAgentsFromSessions([finished])).toEqual([]);
    expect(
      liveAgentsFromSessions([finished], new Set([finished.id])),
    ).toEqual([
      {
        id: finished.id,
        cwd: "/tmp/done",
        title: "Fix the sidebar",
        harness: "claude",
        activity: "Done",
        startedAt: 1_000,
        durationMs: 12_000,
        needsApproval: false,
        done: true,
      },
    ]);
  });

  it("keeps a working session above a finished one", () => {
    const working = chat("/tmp/a", {
      busy: true,
      blocks: [{ id: "u1", role: "user", text: "go", startedAt: 5_000 }],
    });
    const finished = chat("/tmp/b", {
      blocks: [
        {
          id: "u1",
          role: "user",
          text: "go",
          startedAt: 1_000,
          durationMs: 8_000,
        },
      ],
    });
    expect(
      liveAgentsFromSessions(
        [finished, working],
        new Set([finished.id]),
      ).map((row) => row.cwd),
    ).toEqual(["/tmp/a", "/tmp/b"]);
  });
});

describe("formatLiveElapsed", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatLiveElapsed(0, 1_000)).toBe("1s");
    expect(formatLiveElapsed(0, 38_000)).toBe("38s");
    expect(formatLiveElapsed(0, 72_000)).toBe("1m 12s");
    expect(formatLiveElapsed(0, 120_000)).toBe("2m");
    expect(formatLiveElapsed(0, 3_600_000)).toBe("1h");
    expect(formatLiveElapsed(0, 3_720_000)).toBe("1h 2m");
  });
});

// r92 (c02 blind run 0176): the sidebar foot never shows a raw tool name or a path outside the project.
describe("r92 sidebar foot activity", () => {
  const busy = (block: Block) =>
    chat("/p/tally", { busy: true, blocks: [{ id: "u1", role: "user", text: "go", startedAt: 1_000 }, block] });
  it("says what a MonoCode tool does instead of its raw name", () => {
    const block: Block = { id: "t", role: "tool", text: "mcp__monocode__task_wait", tool: { kind: "other", status: "in_progress", title: "mcp__monocode__task_wait" } };
    const [agent] = liveAgentsFromSessions([busy(block)]);
    expect(agent.activity).not.toMatch(/mcp__/);
    expect(agent.activity).toBe("Waiting on a worker");
  });
  it("reads a worker's file by name, not its /private/var path", () => {
    const path = "/private/var/folders/x/T/w/packages/ui/src/format.ts";
    const block: Block = { id: "r", role: "tool", text: `Read ${path}`, tool: { kind: "read", status: "in_progress", title: `Read ${path}`, preview: { kind: "read", path, fileName: "format.ts" } } };
    const [agent] = liveAgentsFromSessions([busy(block)]);
    expect(agent.activity).toBe("Reading format.ts");
  });
});

describe("r94 sidebar foot rows read like the chat (Critiquito a)", () => {
  const busy = (block: Block) =>
    chat("/p/tally", { busy: true, blocks: [{ id: "u1", role: "user", text: "go", startedAt: 1_000 }, block] });
  it("a regex search names its words, never the pattern", () => {
    const block: Block = { id: "g", role: "tool", text: "grep weekStart|monday\\b", tool: { kind: "search", status: "in_progress", title: "grep", preview: { kind: "search", query: "weekStart|monday\\b|rollover" } } };
    const [agent] = liveAgentsFromSessions([busy(block)]);
    expect(agent.activity).not.toMatch(/[|\\]/);
    expect(agent.activity).toMatch(/^Search/);
  });
  it("an edit outside the project names just the file, never a temp path", () => {
    const path = "/tmp/mc-w2/packages/api/src/stats.ts";
    const block: Block = { id: "e", role: "tool", text: `Edit ${path}`, tool: { kind: "edit", status: "in_progress", title: `Edit ${path}`, preview: { kind: "edit", path, fileName: "stats.ts" } } };
    const [agent] = liveAgentsFromSessions([busy(block)]);
    expect(agent.activity).toBe("Editing stats.ts");
  });
  it("any other MCP tool reads in words", () => {
    const block: Block = { id: "m", role: "tool", text: "mcp__linear__list_issues", tool: { kind: "other", status: "in_progress", title: "mcp__linear__list_issues" } };
    const [agent] = liveAgentsFromSessions([busy(block)]);
    expect(agent.activity).toBe("Using Linear: list issues");
  });
});
