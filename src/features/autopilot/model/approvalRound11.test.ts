// Round 11: the provider pins the chat folder (Claude's launch keeps its shell and tools in it, so a relative search or shell
// word is judged there), a Windows colon after the drive is an NTFS stream and waits, and git's -O reads a glued file name.
import { describe, expect, it } from "vitest";
import { approvalCall } from "../../../integrations/harness/providers/claude/claudeProtocol";
import { sessionWorkCwd } from "../../sessions/model/session";
import { approvalVerdict } from "./decide";
import { editInside, openedForm, openedSearchPath, safeCommand } from "./safeApproval";

const CHAT = "/Users/example/Projects/app";
const block = (call: unknown) => ({ text: "", tool: { title: "t", kind: "search" }, approval: { call } }) as any;

describe("round 11: a provider's pin is set by the provider, not by the tool input", () => {
  it("is set by the Claude builder for every tool, whatever the tool input says", () => {
    expect(approvalCall("Grep", { pattern: "x" }).folderPinned).toBe(true);
    expect(approvalCall("Bash", { command: "ls" }).folderPinned).toBe(true);
    expect(approvalCall("Grep", { pattern: "x", folderPinned: false }).folderPinned).toBe(true);
  });

  it("allows a Claude no-path Grep inside the chat, and holds the same search from another provider", () => {
    expect(approvalVerdict(block(approvalCall("Grep", { pattern: "token" })), CHAT)).toMatchObject({ kind: "allow" });
    expect(approvalVerdict(block({ tool: "Grep", paths: undefined }), CHAT)).toMatchObject({ kind: "held" });
  });

  it("resolves a Claude relative Glob pattern against the chat folder, and holds it from another provider", () => {
    expect(openedSearchPath("src/**/*.ts", CHAT, true)).toEqual({ path: `${CHAT}/src/**/*.ts` });
    expect(openedSearchPath("src/**/*.ts", CHAT, false)).toMatchObject({ why: expect.any(String) });
  });

  it("keeps the file tools absolute-only even when the provider pins the folder", () => {
    expect(openedForm("src/a.ts", CHAT)).toMatchObject({ why: expect.stringContaining("relative") });
  });
});

describe("round 11: a shell word's relative operand waits from a provider that doesn't pin its folder", () => {
  it("holds a relative operand from another provider, and judges it in the chat for Claude", () => {
    expect(safeCommand("cat src/a.ts", CHAT, false, false)).not.toBeNull();
    expect(safeCommand("cat src/a.ts", CHAT, false, true)).toBeNull();
    expect(safeCommand("cat /Users/example/Projects/app/src/a.ts", CHAT, false, false)).toBeNull();
  });
});

describe("round 11 (HIGH, Windows): a colon after the drive is an NTFS stream, so an edit or a read of one waits", () => {
  const WIN = "C:\\Users\\dev\\Projects\\app";
  it.each(["opencode.json::$DATA", "CLAUDE.md::$DATA", "src\\HEAD::$DATA", "AGENTS.md:x"])("holds an edit of %s", (name) => {
    expect(editInside(`${WIN}\\${name}`, WIN)).not.toBeNull();
  });
  it("holds a read of a stream, and allows a plain Windows file", () => {
    expect(openedForm(`${WIN}\\src\\a.ts:x`, WIN)).toMatchObject({ why: expect.stringContaining("colon") });
    expect(openedForm(`${WIN}\\src\\a.ts`, WIN)).toEqual({ path: `${WIN}\\src\\a.ts` });
  });
});

describe("round 11 (LOW): git's -O reads a glued orderfile name, so a home timer holds it", () => {
  it("holds git log -Onotes as it holds git log -O notes", () => {
    expect(safeCommand("git log -Onotes", "/Users/example", true)).not.toBeNull();
    expect(safeCommand("git log -O notes", "/Users/example", true)).not.toBeNull();
  });
});

describe("round 11: the launch folder the checks use is the working copy", () => {
  it("uses the worktree when a chat has one, and the chat folder otherwise", () => {
    expect(sessionWorkCwd({ cwd: CHAT, worktreeCwd: `${CHAT}-wt` })).toBe(`${CHAT}-wt`);
    expect(sessionWorkCwd({ cwd: CHAT })).toBe(CHAT);
  });
});
