// Round 12 tests restored after the lead's review file replaced this text in 40fd0c0b8. Adapted only where an import
// moved; these helpers are still where they were.
//
// Round 12: a Windows search that starts outside the chat folder waits, the Claude launch pins its folder in flag
// settings (a project's env cannot switch the pin off), and the provider can drop the pin without the tool input doing it.
import { describe, expect, it } from "vitest";
import { approvalCall, buildClaudeSpawnArgs } from "../../../integrations/harness/providers/claude/claudeProtocol";
import { walkHeld } from "./credentialPaths";
import { approvalVerdict } from "./decide";
import { searchStartsOutside } from "./safeApproval";

const WIN = "C:\\Users\\dev\\Projects\\app";
const MAC = "/Users/example/Projects/app";
const block = (call: unknown) => ({ text: "", tool: { title: "t", kind: "search" }, approval: { call } }) as any;
const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]) as { env?: Record<string, string> };

describe("round 12 (HIGH, Windows): a search that starts outside the chat folder waits", () => {
  it("holds a drive path a find walks, and allows one inside the chat folder", () => {
    expect(walkHeld(["find", "C:\\Users\\dev\\Projects\\other"], WIN)).toBe(true);
    expect(walkHeld(["find", "C:\\Users\\dev"], WIN)).toBe(true);
    expect(walkHeld(["find", "C:\\Users\\dev\\Projects\\app\\src"], WIN)).toBe(false);
    expect(walkHeld(["find", "src"], WIN)).toBe(false);
  });

  it("holds a drive path when the chat folder is not a drive path", () => {
    expect(walkHeld(["find", "C:\\Windows\\System32"], "~/work/app/src")).toBe(true);
  });

  it("holds a Grep and a Glob that start outside the chat, in either case", () => {
    const grep = approvalCall("Grep", { pattern: "API_KEY", path: "C:\\Users\\dev\\Projects\\other\\src" });
    expect(searchStartsOutside(grep, WIN)).toBe(true);
    expect(approvalVerdict(block(grep), WIN)).toMatchObject({ kind: "held" });
    const glob = approvalCall("Glob", { path: "C:\\Users\\dev", pattern: "**/*" });
    expect(approvalVerdict(block(glob), WIN)).toMatchObject({ kind: "held" });
    const inside = approvalCall("Grep", { pattern: "token", path: "c:\\Users\\dev\\Projects\\app\\src" });
    expect(approvalVerdict(block(inside), WIN)).toMatchObject({ kind: "allow" });
  });

  it("still holds a Mac search that starts outside the chat folder", () => {
    const grep = approvalCall("Grep", { pattern: "API_KEY", path: "/Users/example/Projects/other/src" });
    expect(approvalVerdict(block(grep), MAC)).toMatchObject({ kind: "held" });
  });
});

describe("round 12 (MED): the folder pin is in the flag settings, and the tool input cannot set it", () => {
  it("puts the pin in flag settings for a chat, over a caller value of 0", () => {
    expect(settingsOf(buildClaudeSpawnArgs({})).env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
    const overridden = buildClaudeSpawnArgs({
      settings: { env: { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "0", OTHER: "kept" } },
    });
    expect(settingsOf(overridden).env).toMatchObject({
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
      OTHER: "kept",
    });
  });

  it("does not pin an isolated helper, which has no chat folder", () => {
    expect(settingsOf(buildClaudeSpawnArgs({ isolated: true })).env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBeUndefined();
  });

  it("drops the pin only when the provider says the folder moved, never from the tool input", () => {
    expect(approvalCall("Grep", { pattern: "x", folderPinned: false }).folderPinned).toBe(true);
    expect(approvalCall("Grep", { pattern: "token" }, false).folderPinned).toBe(false);
    expect(approvalVerdict(block(approvalCall("Grep", { pattern: "token" }, false)), MAC)).toMatchObject({ kind: "held" });
    expect(approvalVerdict(block(approvalCall("Bash", { command: "cat src/a.ts" }, false)), MAC)).toMatchObject({ kind: "held" });
  });
});
