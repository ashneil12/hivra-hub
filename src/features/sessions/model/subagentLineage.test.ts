import { describe, expect, it } from "vitest";
import {
  foldLineage,
  lineageFromBlocks,
  mergeLineage,
  NOT_REPORTED_BY_CLI,
  type LineageChild,
} from "./subagentLineage";

const claudeExplore = [
  {
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_agent",
          name: "Task",
          input: {
            description: "Explore the auth module",
            subagent_type: "explore",
            model: "claude-haiku-5",
          },
        },
      ],
    },
  },
  {
    type: "system",
    subtype: "task_started",
    task_id: "t1",
    tool_use_id: "toolu_agent",
    description: "Explore the auth module",
    task_type: "local_agent",
  },
  {
    type: "assistant",
    session_id: "sub_1",
    parent_tool_use_id: "toolu_agent",
    message: {
      model: "claude-haiku-5",
      content: [{ type: "text", text: "Looking." }],
    },
  },
  {
    type: "user",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_agent",
          content: "Auth lives in src/auth.",
        },
      ],
    },
  },
];

const codexReview = [
  {
    method: "thread/started",
    params: { thread: { id: "thr_child", model: "gpt-5.6-sol" } },
  },
  {
    method: "item/started",
    params: {
      threadId: "thr_child",
      item: {
        id: "child_cmd",
        type: "commandExecution",
        command: "git diff",
        status: "inProgress",
      },
    },
  },
  {
    method: "item/started",
    params: {
      threadId: "thr_1",
      item: {
        id: "collab_1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        prompt: "Correctness review\n\nLook for regressions.",
        agentsStates: { thr_child: { status: "running" } },
      },
    },
  },
];

function child(lineage: ReturnType<typeof foldLineage>, id: string): LineageChild {
  expect(lineage.reported).toBe(true);
  if (!lineage.reported) throw new Error("unreported");
  const found = lineage.children.find((row) => row.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

describe("Claude fixture transcripts", () => {
  it("produces one child with name, role, model, and result", () => {
    const row = child(foldLineage("claude", claudeExplore), "toolu_agent");
    expect(row).toMatchObject({
      name: "Explore the auth module",
      role: "explore",
      model: "claude-haiku-5",
      status: "done",
      result: "Auth lives in src/auth.",
      error: null,
      sessionPort: "sub_1",
    });
  });

  it("keeps a failed child failed when a late result arrives", () => {
    const frames = [
      ...claudeExplore.slice(0, 2),
      {
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        tool_use_id: "toolu_agent",
        status: "failed",
        summary: "The model name was unknown.",
      },
      claudeExplore[3],
    ];
    const row = child(foldLineage("claude", frames), "toolu_agent");
    expect(row.status).toBe("failed");
    expect(row.error).toBe("The model name was unknown.");
    expect(row.result).toBeNull();
  });

  it("folds a duplicate start onto the same child", () => {
    const frames = [
      claudeExplore[0],
      claudeExplore[1],
      { ...claudeExplore[1], description: "" },
    ];
    const lineage = foldLineage("claude", frames);
    expect(lineage.reported && lineage.children).toHaveLength(1);
    expect(child(lineage, "toolu_agent").name).toBe("Explore the auth module");
  });

  it("does not reopen a stopped child when more progress arrives", () => {
    const frames = [
      claudeExplore[1],
      {
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        tool_use_id: "toolu_agent",
        status: "stopped",
        summary: "Stopped.",
      },
      {
        type: "system",
        subtype: "task_progress",
        task_id: "t1",
        tool_use_id: "toolu_agent",
        description: "Explore the auth module",
        last_tool_name: "Read",
      },
    ];
    expect(child(foldLineage("claude", frames), "toolu_agent").status).toBe("cancelled");
  });

  it("names a child that arrived with no description", () => {
    const row = child(
      foldLineage("claude", [
        {
          type: "system",
          subtype: "task_started",
          task_id: "t9",
          task_type: "local_agent",
        },
      ]),
      "t9",
    );
    expect(row.name).toBe("Subagent");
    expect(row.role).toBeNull();
    expect(row.model).toBeNull();
    expect(row.status).toBe("running");
  });

  it("ignores a background shell and an ambient watcher", () => {
    const lineage = foldLineage("claude", [
      {
        type: "system",
        subtype: "task_started",
        task_id: "bash_1",
        task_type: "local_bash",
        description: "sleep 10",
      },
      {
        type: "system",
        subtype: "task_started",
        task_id: "watch",
        task_type: "local_agent",
        description: "watcher",
        ambient: true,
      },
    ]);
    expect(lineage).toEqual({ reported: true, children: [] });
  });

  it("skips junk frames and still reports an empty transcript", () => {
    expect(foldLineage("claude", [])).toEqual({ reported: true, children: [] });
    expect(foldLineage("claude", [null, "nope", 4, [], { type: "assistant" }])).toEqual({
      reported: true,
      children: [],
    });
  });

  it("trims odd whitespace and keeps a unicode name", () => {
    const row = child(
      foldLineage("claude", [
        {
          type: "system",
          subtype: "task_started",
          task_id: "t1",
          tool_use_id: "toolu_cafe",
          description: "  Café review\r\n\r\nmore",
          task_type: "local_agent",
        },
      ]),
      "toolu_cafe",
    );
    expect(row.name).toBe("Café review");
  });

  it("links a stored transcript when the child session id is already known", () => {
    const row = child(
      foldLineage("claude", claudeExplore, [{ id: "hivra-9", providerSessionId: "sub_1" }]),
      "toolu_agent",
    );
    expect(row.transcriptSessionId).toBe("hivra-9");
  });

  it("does not invent a transcript link", () => {
    expect(child(foldLineage("claude", claudeExplore), "toolu_agent").transcriptSessionId).toBeNull();
  });
});

describe("Codex fixture transcripts", () => {
  it("banks the child's early work and keeps one row", () => {
    const row = child(foldLineage("codex", codexReview), "collab_1");
    expect(row).toMatchObject({
      name: "Correctness review",
      model: "gpt-5.6-sol",
      status: "running",
      sessionPort: "thr_child",
      result: null,
      error: null,
    });
    expect(foldLineage("codex", codexReview).reported && foldLineage("codex", codexReview).children).toHaveLength(1);
  });

  it("records the result when the child finishes", () => {
    const frames = [
      ...codexReview,
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          item: {
            id: "collab_2",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            receiverThreadIds: ["thr_child"],
            agentsStates: { thr_child: { status: "completed", message: "No regressions." } },
          },
        },
      },
    ];
    const row = child(foldLineage("codex", frames), "collab_1");
    expect(row.status).toBe("done");
    expect(row.result).toBe("No regressions.");
  });

  it("gives a failed duplicate its own row", () => {
    const frames = [
      codexReview[2],
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          item: {
            id: "sa_1",
            type: "subAgentActivity",
            kind: "interrupted",
            agentThreadId: "thr_child",
          },
        },
      },
    ];
    const lineage = foldLineage("codex", frames);
    expect(lineage.reported && lineage.children.map((row) => row.id)).toEqual(["collab_1", "sa_1"]);
    expect(child(lineage, "sa_1").status).toBe("failed");
  });

  it("names a subagent from its path when that is all Codex sent", () => {
    const row = child(
      foldLineage("codex", [
        {
          method: "item/completed",
          params: {
            threadId: "thr_1",
            item: {
              id: "sa_1",
              type: "subAgentActivity",
              kind: "started",
              agentPath: "/root/explore-auth",
              agentThreadId: "thr_child",
            },
          },
        },
      ]),
      "sa_1",
    );
    expect(row.name).toBe("Explore Auth subagent");
    expect(row.sessionPort).toBe("thr_child");
  });

  it("reports an empty Codex transcript as no children", () => {
    expect(foldLineage("codex", [])).toEqual({ reported: true, children: [] });
  });
});

describe("a CLI that does not report children", () => {
  it("labels the provider and does not invent children from lookalike frames", () => {
    for (const provider of ["hermes", "cursor", "pi", "devin", "opencode", ""]) {
      expect(foldLineage(provider, claudeExplore)).toEqual({
        reported: false,
        label: NOT_REPORTED_BY_CLI,
        children: [],
      });
    }
  });
});

describe("two windows folding the same child", () => {
  it("keeps the finished copy when the other window is still running", () => {
    const running = foldLineage("claude", claudeExplore.slice(0, 2));
    const done = foldLineage("claude", claudeExplore);
    const merged = mergeLineage(done, running);
    expect(child(merged, "toolu_agent")).toMatchObject({
      status: "done",
      result: "Auth lives in src/auth.",
      name: "Explore the auth module",
    });
  });

  it("takes a newer failure without wiping the name", () => {
    const named = foldLineage("claude", claudeExplore.slice(0, 2));
    const failed = foldLineage("claude", [
      {
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        tool_use_id: "toolu_agent",
        status: "failed",
        summary: "Timed out.",
      },
    ]);
    expect(child(mergeLineage(named, failed), "toolu_agent")).toMatchObject({
      name: "Explore the auth module",
      status: "failed",
      error: "Timed out.",
    });
  });
});

describe("children already stored on the session", () => {
  const storedChild = {
    id: "b1",
    role: "tool",
    text: "Explore the auth module",
    tool: { callId: "toolu_agent", kind: "agent", title: "Explore the auth module", status: "completed", detail: "Auth lives in src/auth." },
    agentRun: {
      name: "Explore the auth module",
      agentType: "explore",
      model: "claude-haiku-5",
      sessionPort: "sub_1",
      steps: [],
    },
  };

  it("reads name, role, model, and result off the stored block", () => {
    const row = child(
      lineageFromBlocks("claude", [storedChild], [{ id: "hivra-9", providerSessionId: "sub_1" }]),
      "toolu_agent",
    );
    expect(row).toMatchObject({
      name: "Explore the auth module",
      role: "explore",
      model: "claude-haiku-5",
      status: "done",
      result: "Auth lives in src/auth.",
      transcriptSessionId: "hivra-9",
    });
  });

  it("keeps a failure as an error", () => {
    const row = child(
      lineageFromBlocks("claude", [
        {
          ...storedChild,
          tool: { ...storedChild.tool, status: "failed", detail: "API error." },
        },
      ]),
      "toolu_agent",
    );
    expect(row.status).toBe("failed");
    expect(row.error).toBe("API error.");
    expect(row.result).toBeNull();
  });

  it("does not turn a workflow or a plain tool into a child", () => {
    const lineage = lineageFromBlocks("claude", [
      { id: "w", role: "tool", text: "Fan out", tool: { kind: "workflow", title: "Fan out", status: "completed" }, workflowRun: { agents: [] } },
      { id: "r", role: "tool", text: "Read notes", tool: { kind: "read", title: "Read notes", status: "completed" } },
      null,
      { id: "bad", role: "tool" },
    ]);
    expect(lineage).toEqual({ reported: true, children: [] });
  });

  it("labels a provider that does not report children, even if a block looks like one", () => {
    expect(lineageFromBlocks("hermes", [storedChild])).toEqual({
      reported: false,
      label: NOT_REPORTED_BY_CLI,
      children: [],
    });
  });

  it("folds two blocks with the same call onto one child", () => {
    const lineage = lineageFromBlocks("codex", [storedChild, { ...storedChild, id: "b2" }]);
    expect(lineage.reported && lineage.children).toHaveLength(1);
  });
});
