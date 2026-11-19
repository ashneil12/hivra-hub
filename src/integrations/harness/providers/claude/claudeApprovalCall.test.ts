import { describe, expect, it } from "vitest";
import { approvalCallComplete } from "./claudeProtocol";
import { respondClaudeApproval } from "./claude";

describe("approval call completeness (WP-150 H1)", () => {
  it("marks a Bash call complete only when every input key is one the phone shows", () => {
    expect(approvalCallComplete("Bash", { command: "git status" })).toBe(true);
    expect(approvalCallComplete("Bash", { command: "npm test", description: "Run tests", timeout: 60_000 })).toBe(true);
  });

  it("does not mark a Bash call complete when it disables the sandbox or carries another input", () => {
    expect(approvalCallComplete("Bash", { command: "rm -rf build", dangerouslyDisableSandbox: true })).toBe(false);
    expect(approvalCallComplete("Bash", { command: "sleep 9", run_in_background: true })).toBe(false);
    expect(approvalCallComplete("Bash", { description: "no command" })).toBe(false);
  });

  it("never marks an MCP, WebFetch, Write, Edit or Task call complete", () => {
    expect(approvalCallComplete("mcp__github__merge_pull_request", { pull_number: 4 })).toBe(false);
    expect(approvalCallComplete("mcp__supabase__execute_sql", { query: "drop table x" })).toBe(false);
    expect(approvalCallComplete("WebFetch", { url: "https://example.com/x" })).toBe(false);
    expect(approvalCallComplete("Write", { file_path: "/w/a.ts", content: "x" })).toBe(false);
    expect(approvalCallComplete("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" })).toBe(false);
    expect(approvalCallComplete("Task", { prompt: "do it" })).toBe(false);
  });
});

describe("respondClaudeApproval (WP-150 M1)", () => {
  it("reports false when no live call holds that request, so the phone is not told it was sent", () => {
    expect(respondClaudeApproval("no-such-chat", 1, "allow")).toBe(false);
    expect(respondClaudeApproval("no-such-chat", 1, "deny")).toBe(false);
  });
});
