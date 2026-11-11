// WP-101 review round 3, items 1, 4 and 5: the shared agent-config list, scheme-led arguments, and braces in folder words.
import { describe, expect, it } from "vitest";
import { editInside, safeCall, safeCommand, searchStartsOutside } from "./safeApproval";
import { isProtectedConfig } from "./protectedConfig";

const FOLDER = "/Users/someone/Worktrees/hub-x";
const SRV = "plugin-agent_plugins-notion";
const wired = new Set([SRV]);

describe("agent and tool config families (review round 3, item 1)", () => {
  it.each([
    "opencode.json",
    "opencode.jsonc",
    ".opencode.json",
    "OPENCODE.JSONC",
    ".omp/extensions/x.ts",
    "mise.toml",
    ".mise.toml",
    "mise.local.toml",
    ".mise.local.toml",
    ".config/mise/config.toml",
    ".mise/config.toml",
    "lefthook.yaml",
    ".lefthook.yml",
    "lefthook-local.yml",
    "lefthook.json",
    "lefthook.toml",
    ".lintstagedrc",
    ".lintstagedrc.yml",
    ".lintstagedrc.mjs",
    "lint-staged.config.js",
    ".pnpmfile.cjs",
    "bunfig.toml",
    "rust-toolchain.toml",
    ".githooks/pre-commit",
    "src/.agents/skills/a/SKILL.md",
    ".pi/settings.json",
  ])("holds an edit to %s", (file) => {
    expect(safeCall({ tool: "Write", paths: [`${FOLDER}/${file}`] }, FOLDER), file).not.toBeNull();
  });

  it.each(["opencode.json.", "opencode.json ", "Ｏpencode.json", ".lintſtagedrc.yml"])("holds a spelled-out form %s", (file) => {
    expect(isProtectedConfig(file.split("/")), file).toBe(true);
  });

  it("still allows an ordinary source edit", () => {
    expect(safeCall({ tool: "Edit", paths: [`${FOLDER}/src/app.ts`] }, FOLDER)).toBeNull();
    expect(editInside(`${FOLDER}/src/app.ts`, FOLDER)).toBeNull();
  });
});

describe("a scheme-led argument is an address (review round 3, item 4)", () => {
  it.each(["http:16909060?d=y", "file:/Users/x/.netrc", "ftp:host", "mailto:x@y.z"])("holds an MCP argument %s", (value) => {
    expect(safeCall({ tool: `mcp__${SRV}__get_issue`, args: [value] } as never, FOLDER, wired), value).not.toBeNull();
  });
  it("holds a resource read whose uri has a scheme", () => {
    expect(safeCall({ tool: "ReadMcpResourceTool", server: SRV, args: ["http:16909060?d=y"] } as never, FOLDER, wired)).not.toBeNull();
  });
});

describe("braces that name a folder outside the chat's (review round 3, item 5)", () => {
  it.each(["{/etc,src}/*", "{../..,src}/**/*", "src/{a,../../etc}/x"])("holds a search over %s", (pattern) => {
    expect(searchStartsOutside({ tool: "Glob", paths: [pattern] } as never, FOLDER), pattern).toBe(true);
  });
  it.each(["ls {/etc,src}", "cat {../..,src}/x", "rg foo {a,../b}"])("holds the shell command %s", (command) => {
    expect(safeCommand(command, FOLDER), command).not.toBeNull();
  });
});
