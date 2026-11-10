// WP-120: a lead never edits the project, on every CLI that can lead.
// A new capable CLI with no check here fails this test. The checks call the
// real launch config, not a flag that could be flipped on its own.
import { describe, expect, it } from "vitest";
import {
  FIRST_MATE_DENY_TOOLS,
  buildClaudeSpawnArgs,
  type ClaudePermissionMode,
} from "../../../integrations/harness/providers/claude/claudeProtocol";
import { runtimeModeToCodexConfig } from "../../../integrations/harness/providers/codex/codexProtocol";
import { HARNESSES, type RuntimeMode } from "../../sessions/model/session";
import { canLead } from "./leadCli";

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const CLAUDE_MODES: ClaudePermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "bypassPermissions",
];
const CODEX_MODES: RuntimeMode[] = ["supervised", "auto-accept-edits", "auto", "full-access"];

function deniedTools(args: string[]): string[] {
  const at = args.indexOf("--disallowedTools");
  return at >= 0 ? (args[at + 1] ?? "").split(",") : [];
}

function claudeLeadDeniesWrites(): boolean {
  return CLAUDE_MODES.every((permissionMode) => {
    const denied = deniedTools(
      buildClaudeSpawnArgs({ firstMate: true, permissionMode, allowBypass: true }),
    );
    return WRITE_TOOLS.every((tool) => denied.includes(tool));
  });
}

function codexLeadDeniesWrites(): boolean {
  return CODEX_MODES.every((mode) => {
    const config = runtimeModeToCodexConfig(mode, true, true);
    return config.sandbox === "read-only" && config.sandboxPolicy.type === "readOnly";
  });
}

const WRITE_DENIAL: Partial<Record<(typeof HARNESSES)[number], () => boolean>> = {
  claude: claudeLeadDeniesWrites,
  codex: codexLeadDeniesWrites,
};

describe("a lead does not edit the project", () => {
  it("keeps write tools off for every CLI that can lead", () => {
    expect(FIRST_MATE_DENY_TOOLS).toEqual(expect.arrayContaining(WRITE_TOOLS));
    const capable = HARNESSES.filter((id) => canLead(id));
    expect(capable.length).toBeGreaterThan(0);
    for (const id of capable) {
      const check = WRITE_DENIAL[id];
      expect(check, `${id} can lead but nothing proves its writes stay off`).toBeTypeOf("function");
      expect(check!(), id).toBe(true);
    }
  });

  it("still denies Claude writes in bypass mode, and keeps Codex read-only in full access", () => {
    const bypass = deniedTools(
      buildClaudeSpawnArgs({ firstMate: true, permissionMode: "bypassPermissions", allowBypass: true }),
    );
    for (const tool of WRITE_TOOLS) expect(bypass).toContain(tool);
    const open = runtimeModeToCodexConfig("full-access", true, false);
    expect(open.sandbox).not.toBe("read-only");
    const lead = runtimeModeToCodexConfig("full-access", true, true);
    expect(lead.sandbox).toBe("read-only");
    expect(lead.sandboxPolicy.type).toBe("readOnly");
    expect(lead.sandboxPolicy.networkAccess).toBe(true);
  });
});
