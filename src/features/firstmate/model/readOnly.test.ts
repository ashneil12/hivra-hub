import { describe, expect, it } from "vitest";
import { HARNESSES } from "../../sessions/model/session";
import { buildClaudeSpawnArgs, FIRST_MATE_DENY_TOOLS } from "../../../integrations/harness/providers/claude/claudeProtocol";
import { claudeLaunchDelta, type ClaudeLaunch } from "../../../integrations/harness/providers/claude/claudeLaunch";
import {
  buildThreadStartParams,
  buildTurnStartParams,
  runtimeModeToCodexConfig,
} from "../../../integrations/harness/providers/codex/codexProtocol";
import { FIRST_MATE_READ_ONLY } from "./readOnly";

function denied(args: string[]): string[] {
  return args[args.indexOf("--disallowedTools") + 1].split(",");
}

describe("a first mate runs read-only where its CLI can (Hivra WP-10)", () => {
  it("documents every CLI, and says enforced only for the ones the launch code holds", () => {
    expect(Object.keys(FIRST_MATE_READ_ONLY).sort()).toEqual([...HARNESSES].sort());
    const enforced = Object.entries(FIRST_MATE_READ_ONLY)
      .filter(([, support]) => support.level === "enforced")
      .map(([id]) => id);
    expect(enforced.sort()).toEqual(["claude", "codex"]);
  });

  it("starts Claude Code without file-editing tools, in every permission mode", () => {
    for (const permissionMode of ["default", "acceptEdits", "bypassPermissions", "plan"] as const) {
      const mate = denied(buildClaudeSpawnArgs({ permissionMode, firstMate: true }));
      for (const tool of FIRST_MATE_DENY_TOOLS) expect(mate, permissionMode).toContain(tool);
      expect(mate).not.toContain("Bash");
    }
    // Anyone else keeps them (only the credential rules are denied).
    const worker = denied(buildClaudeSpawnArgs({ permissionMode: "bypassPermissions" }));
    for (const tool of FIRST_MATE_DENY_TOOLS) expect(worker).not.toContain(tool);
  });

  it("restarts a Claude process that becomes, or stops being, a first mate", () => {
    const base: ClaudeLaunch = { permissionMode: "default", allowBypass: false, thinking: false, fast: false, ultracode: false, hooks: true };
    expect(claudeLaunchDelta(base, { ...base, firstMate: true }).restart).toContain("first mate");
    expect(claudeLaunchDelta({ ...base, firstMate: true }, base).restart).toContain("first mate");
    expect(claudeLaunchDelta(base, base).restart).toEqual([]);
  });

  it("runs Codex in its read-only sandbox with no escalation, network on for the delegate tool, in every mode", () => {
    for (const mode of ["supervised", "auto-accept-edits", "auto", "full-access"] as const) {
      expect(runtimeModeToCodexConfig(mode, false, true)).toEqual({
        approvalPolicy: "never",
        sandbox: "read-only",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: true },
      });
      const thread = buildThreadStartParams({ cwd: "/p", runtimeMode: mode, firstMate: true });
      expect(thread).toMatchObject({ sandbox: "read-only", sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" });
      const turn = buildTurnStartParams({ threadId: "t", runtimeMode: mode, firstMate: true, prompt: "hi" });
      expect(turn).toMatchObject({ sandboxPolicy: { type: "readOnly" }, approvalPolicy: "never" });
    }
    // A worker in full access keeps full access.
    expect(runtimeModeToCodexConfig("full-access").sandbox).toBe("danger-full-access");
  });
});
