// WP-178: the protected-paths list and the after-turn report. The report names what a turn touched; it never blocks or reverts.
import { describe, expect, it } from "vitest";
import { PROTECTED_PATHS, diffFingerprints, matchProtected, reportProtectedTouches } from "./protectedPaths";

describe("matchProtected", () => {
  it.each([
    [".git/hooks/pre-commit", "git hooks"],
    [".git/config", "git config"],
    [".claude/settings.json", "Claude settings"],
    [".claude/settings.local.json", "Claude settings"],
    [".claude/hooks/on-stop.sh", "Claude hooks"],
    [".claude/commands/ship.md", "Claude commands"],
    [".claude/skills/review/SKILL.md", "Claude skills"],
    [".codex/config.toml", "Codex settings"],
    [".cursor/mcp.json", "Cursor MCP config"],
    [".opencode/opencode.jsonc", "OpenCode settings"],
    [".agents/skills/review/SKILL.md", "shared skills"],
    ["~/.zshrc", "shell profile"],
    ["~/.zprofile", "shell profile"],
    ["~/.bashrc", "shell profile"],
    ["~/.claude/settings.json", "Claude settings"],
    ["~/.codex/config.toml", "Codex settings"],
  ])("protects %s", (path) => {
    expect(matchProtected(path)).not.toBeNull();
  });

  it.each([
    ["src/app.ts"],
    ["README.md"],
    [".github/workflows/ci.yml"],
    [".claude-notes.md"],
    [".git/HEAD"],
    ["~/Documents/note.txt"],
    ["src/.claude/unrelated.txt"],
  ])("leaves %s alone", (path) => {
    expect(matchProtected(path)).toBeNull();
  });

  it("names the rule and the reason it matched", () => {
    const hit = matchProtected(".git/hooks/pre-commit");
    expect(hit?.pattern).toBe(".git/hooks/**");
    expect(hit?.why.length).toBeGreaterThan(0);
  });

  it("keeps the list in one place, with a reason on every entry", () => {
    expect(PROTECTED_PATHS.length).toBeGreaterThan(10);
    for (const rule of PROTECTED_PATHS) {
      expect(rule.pattern).not.toMatch(/^\//);
      expect(rule.why.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("diffFingerprints", () => {
  it("reports added, removed and modified paths, and skips unchanged ones", () => {
    const before = { "~/.zshrc": "a", ".git/config": "b", ".claude/settings.json": "c" };
    const after = { "~/.zshrc": "a2", ".git/config": "b", ".git/hooks/pre-commit": "d" };
    expect(diffFingerprints(before, after).sort()).toEqual(
      [".claude/settings.json", ".git/hooks/pre-commit", "~/.zshrc"].sort(),
    );
  });
});

describe("reportProtectedTouches", () => {
  it("names each protected path a turn touched, and nothing else", () => {
    const report = reportProtectedTouches(["src/a.ts", ".git/hooks/pre-commit", "~/.zshrc"]);
    expect(report.touched.map((t) => t.path)).toEqual([".git/hooks/pre-commit", "~/.zshrc"]);
    expect(report.summary).toMatch(/2 protected/);
  });

  it("is clean when nothing protected changed", () => {
    const report = reportProtectedTouches(["src/a.ts"]);
    expect(report.touched).toEqual([]);
    expect(report.summary).toMatch(/nothing protected/i);
  });

  it("only reports: the result has no revert or block field", () => {
    const report = reportProtectedTouches([".claude/settings.json"]);
    expect(Object.keys(report).sort()).toEqual(["summary", "touched"]);
  });
});
