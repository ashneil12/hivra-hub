// Review of PR #201 rounds 12 to 14 (head 9271edd12): red-first repros. Each `it` here fails at 9271edd12.
//
// Both findings are LOW: a later layer holds the first in practice, and Claude Code itself answers most of the second.
//
// 1. A Windows drive-relative word on another drive (`D:notes.txt`, `D:Users`) opens that drive's current folder (its root,
//    for a process that never changed to it), so it names a place outside the chat folder. wordOutside and walkHeld anchor
//    a drive only when a separator follows the colon (`D:\`, `D:/`, or a bare `D:`), so the words check reads `D:notes.txt`
//    as a name in the chat folder and allows it. On Windows the Rust lookup refuses `<chat>/D:notes.txt` (has_stream_suffix:
//    a colon after the drive), so the approval still waits; the words check should hold it by itself, as it does `D:\x`.
//
// 2. A subagent spawned with `isolation: "worktree"` works in its own worktree. Measured on Claude Code 2.1.322 with a
//    scripted API: from a chat in a linked worktree (`<repo>-wt`), the subagent's `pwd` printed
//    `<repo>/.claude/worktrees/agent-<id>`, outside the chat folder, while the parent stayed pinned in the chat folder.
//    The app marks every subagent ask with the parent's pin (answerChildClaudeApproval gets `pinned` from the parent), so
//    a subagent's no-path or relative search is judged in the chat folder. (A plain subagent's EnterWorktree is refused by
//    Claude Code: "cannot create a worktree from a subagent with a cwd override", so it never moves the parent.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
  execChild: async () => "",
}));

const { sendClaudeTurn, respondClaudeApproval, stopClaudeSession, __claudeTestReset } = await import(
  "../../../integrations/harness/providers/claude/claude"
);
const { approvalCall } = await import("../../../integrations/harness/providers/claude/claudeProtocol");
const { approvalVerdict } = await import("./decide");
type HarnessEvent = import("../../../integrations/harness/core/types").HarnessEvent;

const parse = () => sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const emit = (rec: Record<string, unknown>) => onLine!(JSON.stringify(rec));
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function startTurn(sessionId: string, cwd: string) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId,
    cwd,
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "look around",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  await waitFor(() => parse().some((m) => (m.request as { subtype?: string } | undefined)?.subtype === "initialize"), "initialize");
  emit({ type: "system", subtype: "init", session_id: "sess_1", cwd });
  emit({ type: "control_response", response: { subtype: "success", request_id: "monocode_1" } });
  await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
  return { events, turn };
}

const block = (call: unknown) => ({ text: "", tool: { title: "t", kind: "execute" }, approval: { call } }) as any;

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
});
afterEach(async () => {
  await stopClaudeSession("r14").catch(() => undefined);
  __claudeTestReset();
});

describe("LOW (Windows): a drive-relative word on another drive names a place outside the chat folder", () => {
  const WIN = "C:\\Users\\dev\\Projects\\app";
  it.each(["cat D:notes.txt", "find D:Users", "rg TODO D:Users"])("holds `%s` in the words check", (command) => {
    expect(approvalVerdict(block(approvalCall("Bash", { command })), WIN, undefined, new Set())).toMatchObject({ kind: "held" });
  });

  it("holds `D:\\Users` already (control: green)", () => {
    const call = approvalCall("Bash", { command: "find D:\\\\Users" });
    expect(approvalVerdict(block(call), WIN, undefined, new Set())).toMatchObject({ kind: "held" });
  });
});

describe("LOW: a subagent in its own worktree is not in the launch folder, so its asks are not pinned", () => {
  const CHAT = "/Users/dev/Worktrees/hub-x";

  it("does not mark an isolation-worktree subagent's search pinned", async () => {
    const { events, turn } = await startTurn("r14", CHAT);
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "look", prompt: "look around", subagent_type: "general-purpose", isolation: "worktree" },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      session_id: "sess_1",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "tool_use", id: "toolu_sub_grep", name: "Grep", input: { pattern: "TODO" } }] },
    });
    emit({
      type: "control_request",
      request_id: "perm_sub_grep",
      request: { subtype: "can_use_tool", tool_name: "Grep", tool_use_id: "toolu_sub_grep", input: { pattern: "TODO" } },
    });
    await waitFor(() => events.some((e) => e.type === "approval.requested"), "approval");
    const asked = events.find((e) => e.type === "approval.requested") as Extract<HarnessEvent, { type: "approval.requested" }>;
    // Control: it is the subagent's ask (answered on the parent, sent to the child).
    expect(asked.child).toBeDefined();
    // The subagent searches <repo>/.claude/worktrees/agent-<id>, not the chat folder: its no-path Grep must not be judged
    // as a walk of the chat folder.
    expect(asked.call?.folderPinned).not.toBe(true);
    expect(approvalVerdict(block(asked.call), CHAT, undefined, new Set())).toMatchObject({ kind: "held" });
    respondClaudeApproval("r14", asked.requestId, "deny");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn.catch(() => undefined);
  });
});
