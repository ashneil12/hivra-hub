// Review of PR #201 round 11 (head a61ec1ece): red-first repros. Each `it` here fails at a61ec1ece.
//
// The round-11 relaxations (a Claude search with a relative or missing path, and a Claude shell word's relative operand,
// judged in the chat folder) rest on one claim: Claude Code's Bash and file tools always work in the launch folder,
// because the launch sets CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1. Measured on Claude Code 2.1.322 (the native build),
// by capturing the Bash tool's prompt ("Every call starts in the start folder" vs "`cd` carries to the next call"), with
// the app's own `--setting-sources=user,project,local`:
//   - launch env =1, nothing else                                   -> pinned
//   - launch env =1, project .claude/settings.json env "0"          -> NOT pinned (cd carries again)
//   - launch env =1, user settings.json (CLAUDE_CONFIG_DIR) env "0" -> NOT pinned
//   - launch env =1, either of those, plus --settings env "1"       -> pinned (flag settings outrank both)
// And EnterWorktree (no `path`) is allowed by Claude Code's own check (checkPermissions returns allow, no can_use_tool),
// then runs jy(worktreePath) and eH(pe()): it moves both the folder and the folder the Bash reset goes back to.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (_id: string, _path: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const { sendClaudeTurn, respondClaudeApproval, stopClaudeSession, __claudeTestReset } = await import(
  "../../../integrations/harness/providers/claude/claude"
);
const { approvalCall } = await import("../../../integrations/harness/providers/claude/claudeProtocol");
const { worktreeDeniedTools } = await import("../../hub/model/hubMcp");
const { approvalVerdict } = await import("./decide");
const { placeStaysInside } = await import("./safeApproval");
type HarnessEvent = import("../../../integrations/harness/core/types").HarnessEvent;
type Locate = import("./safeApproval").Locate;

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

const block = (call: unknown) => ({ text: "", tool: { title: "t", kind: "search" }, approval: { call } }) as any;

beforeEach(() => {
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
});
afterEach(async () => {
  await stopClaudeSession("r11");
  __claudeTestReset();
});

describe("HIGH (Windows): a search from an absolute path outside the chat folder, on the chat's own drive, waits as it does on a Mac", () => {
  const WIN = "C:\\Users\\dev\\Projects\\app";
  const MAC = "/Users/dev/Projects/app";
  // walkHeld's folderParts() reads only a folder that starts with "/", so for C:\... it takes the "no folder known"
  // branch, where only a word starting with "/" is held. C:\Users\dev\... passes the words check.
  it.each([
    ["Grep", { pattern: "API_KEY", path: "C:\\Users\\dev\\Projects\\other\\src" }],
    ["Grep", { pattern: "password", path: "C:\\Users\\dev\\Documents" }],
    // Held at 2088c2618 only because the relative pattern had no cwd; round 11 pins it and the walk from home passes.
    ["Glob", { pattern: "**/*.env.example", path: "C:\\Users\\dev" }],
  ])("holds a Windows %s with %j", (tool, input) => {
    expect(approvalVerdict(block(approvalCall(tool, input)), WIN, undefined, new Set())).toMatchObject({ kind: "held" });
  });

  it("holds the same search on a Mac (control: green)", () => {
    const call = approvalCall("Grep", { pattern: "API_KEY", path: "/Users/dev/Projects/other/src" });
    expect(approvalVerdict(block(call), MAC, undefined, new Set())).toMatchObject({ kind: "held" });
  });

  it("is not saved by the lookup: another checkout's folder is placed in git, so the read of it is allowed", async () => {
    // fs.rs locate_path on Windows: a path in a git checkout is placed by its checkout. Both are in git here.
    const locate: Locate = async (paths) =>
      paths.map((p) =>
        p.startsWith(`${WIN}/`) || p.startsWith(`${WIN}\\`)
          ? { root: WIN, relative: p.slice(WIN.length + 1).replace(/\\/g, "/"), dotGit: true }
          : p.startsWith("C:\\Users\\dev\\Projects\\other\\")
            ? { root: "C:\\Users\\dev\\Projects\\other", relative: p.slice("C:\\Users\\dev\\Projects\\other\\".length).replace(/\\/g, "/"), dotGit: true }
            : null,
      );
    const call = approvalCall("Grep", { pattern: "API_KEY", path: "C:\\Users\\dev\\Projects\\other\\src" });
    const words = approvalVerdict(block(call), WIN, undefined, new Set());
    const lookup = await placeStaysInside(call, WIN, locate, async (p) => p);
    expect(words.kind === "held" || lookup !== null).toBe(true);
  });
});

describe("MED: the folder pin is set where a project's or the user's settings can't switch it off", () => {
  it("launches Claude with CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 in its flag settings (--settings env)", async () => {
    const { turn } = await startTurn("r11", "/Users/dev/Projects/app");
    const args = spawned[0];
    const settings = args.flatMap((arg, i) => (args[i - 1] === "--settings" ? [JSON.parse(arg) as { env?: Record<string, string> }] : []));
    // harness.rs sets the variable only in the process env, which a committed .claude/settings.json (or settings.local.json,
    // or the account's settings.json) overrides: approvalCall still marks every request folderPinned.
    expect(settings.some((s) => s.env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR === "1")).toBe(true);
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });
});

describe("MED: EnterWorktree moves Claude's folder (and the Bash reset's target) out of the chat folder", () => {
  // A chat in an app worktree. Claude Code makes its worktrees under the canonical checkout's .claude/worktrees, so from a
  // linked worktree the new folder is outside the chat folder. A plain chat keeps EnterWorktree (hubMcp.ts), and Claude
  // Code runs it with no permission request.
  const CHAT = "/Users/dev/Worktrees/hub-x";
  const MOVED = "/Users/dev/Projects/hub/.claude/worktrees/w1";

  it("does not judge a no-path search in the chat folder after the session entered a worktree", async () => {
    const plainChatDenies = worktreeDeniedTools({ kind: "chat", chat: "plain-1" }).includes("EnterWorktree");
    const { events, turn } = await startTurn("r11", CHAT);
    emit({ type: "assistant", session_id: "sess_1", message: { content: [{ type: "tool_use", id: "toolu_ew", name: "EnterWorktree", input: {} }] } });
    emit({
      type: "user",
      session_id: "sess_1",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_ew", content: `Created worktree at ${MOVED} on branch worktree-w1. The session is now working in the worktree.` }] },
    });
    emit({ type: "assistant", session_id: "sess_1", message: { content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "token" } }] } });
    emit({
      type: "control_request",
      request_id: "perm_grep",
      request: { subtype: "can_use_tool", tool_name: "Grep", tool_use_id: "toolu_grep", input: { pattern: "token" } },
    });
    await waitFor(() => events.some((e) => e.type === "approval.requested"), "approval");
    const asked = events.find((e) => e.type === "approval.requested") as Extract<HarnessEvent, { type: "approval.requested" }>;
    const verdict = approvalVerdict(block(asked.call), CHAT, undefined, new Set());
    // Either the chat can't run EnterWorktree, or a request after it is no longer judged in the chat folder.
    expect(plainChatDenies || verdict.kind === "held").toBe(true);
    respondClaudeApproval("r11", asked.requestId, "deny");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });
});

describe("LOW (Windows CI): harness.rs keeps its unix-only test module out of a Windows build", () => {
  it("leaves #[cfg(unix)] on `mod tests`, which uses std::os::unix", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../../src-tauri/src/harness.rs"), "utf8");
    const at = src.indexOf("#[cfg(test)]\nmod tests {");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, at + 4000);
    expect(body).toContain("use std::os::unix::process::CommandExt;");
    expect(src.slice(Math.max(0, at - 20), at)).toContain("#[cfg(unix)]");
  });
});
