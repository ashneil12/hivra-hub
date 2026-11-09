import { lstat, mkdir, readlink, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { joinPath } from "../../../shared/lib/paths";
import {
  acceptLoadedReport,
  hiddenFromSentence,
  loadParityReport,
  readFailureNotice,
  skillNameFromMarkdown,
  skillSwitchNotice,
  tomlMcpServers,
  type DirKind,
  type ParityFs,
  type ParityReport,
} from "./cliParity";

const SKILL = (name: string) => `---\nname: ${name}\n---\n\n# ${name}\n`;

function memoryFs(files: Record<string, string>, extraList?: (dir: string) => { name: string; kind: DirKind }[] | null) {
  const stored = new Map(Object.entries(files).map(([file, text]) => [file.replace(/\\/g, "/").replace(/\/+$/, ""), text]));
  const calls: string[] = [];
  const fs: ParityFs = {
    async readText(file) {
      const normal = file.replace(/\\/g, "/");
      calls.push(normal);
      return stored.get(normal.replace(/\/+$/, "")) ?? null;
    },
    async list(dir) {
      const normal = dir.replace(/\\/g, "/").replace(/\/+$/, "");
      calls.push(normal);
      if (extraList) {
        const extra = extraList(normal);
        if (extra) return extra;
      }
      if (stored.has(normal)) return null;
      const names = new Map<string, DirKind>();
      for (const file of stored.keys()) {
        if (!file.startsWith(`${normal}/`)) continue;
        const rest = file.slice(normal.length + 1);
        const [seg, ...more] = rest.split("/");
        if (!seg) continue;
        names.set(seg, more.length > 0 || names.get(seg) === "dir" ? "dir" : "file");
      }
      return names.size === 0 ? null : [...names.entries()].map(([name, kind]) => ({ name, kind }));
    },
    async readLink() {
      return null;
    },
  };
  return { fs, calls };
}

describe("skill names", () => {
  it("reads a CRLF frontmatter name and ignores a name past the first 16KB", () => {
    expect(skillNameFromMarkdown("---\r\nname: crlf-skill\r\n---\r\n", "other")).toBe("crlf-skill");
    expect(skillNameFromMarkdown("---\nname: Review\n---\n", "review-pr")).toBe("review-pr");
    const padded = `${"x".repeat(16 * 1024)}\n---\nname: hidden-name\n---\n`;
    expect(skillNameFromMarkdown(padded, "visible-skill")).toBe("visible-skill");
  });

  it("skips a folder whose name has no ascii slug", () => {
    expect(skillNameFromMarkdown("# no frontmatter\n", "ревью")).toBeNull();
    expect(skillNameFromMarkdown("# notes\n", "my notes")).toBe("my-notes");
  });
});

describe("switch notice", () => {
  const shared: ParityReport = {
    skills: [
      {
        name: "review",
        path: ".agents/skills/review/SKILL.md",
        scope: "project",
        place: "agents",
        readers: ["codex", "cursor", "opencode", "pi", "claude"],
        sharedFile: true,
      },
    ],
    mcp: [
      { cli: "claude", name: "docs", scope: "user", path: "~/.claude.json" },
      { cli: "codex", name: "docs", scope: "user", path: "~/.codex/config.toml" },
    ],
    rules: [
      { path: "AGENTS.md", readers: ["claude", "codex", "cursor"], pointer: false },
      { path: "CLAUDE.md", readers: ["claude"], pointer: true },
    ],
  };

  it("says nothing when the same CLI stays, or when every skill, server and rule travels", () => {
    expect(skillSwitchNotice("claude", "claude", "Claude Code", shared)).toBeNull();
    expect(skillSwitchNotice("claude", "codex", "Codex", shared)).toBeNull();
    expect(skillSwitchNotice("codex", "claude", "Claude Code", shared)).toBeNull();
  });

  it("treats the same skill name as traveling even when the files differ", () => {
    const report: ParityReport = {
      skills: [
        { ...shared.skills[0], readers: ["claude"], place: "claude", sharedFile: false, path: ".claude/skills/review/SKILL.md" },
        { ...shared.skills[0], readers: ["codex", "cursor"], place: "agents", sharedFile: true },
      ],
      mcp: [],
      rules: [],
    };
    expect(skillSwitchNotice("claude", "codex", "Codex", report)).toBeNull();
  });

  it("names a Claude-only skill, server and rule, and skips a CLAUDE.md that only points at AGENTS.md", () => {
    const report: ParityReport = {
      skills: [
        {
          name: "review",
          path: ".claude/skills/review/SKILL.md",
          scope: "project",
          place: "claude",
          readers: ["claude"],
          sharedFile: false,
        },
      ],
      mcp: [{ cli: "claude", name: "docs", scope: "project", path: ".mcp.json" }],
      rules: [
        { path: "AGENTS.md", readers: ["claude", "codex", "cursor"], pointer: false },
        { path: "CLAUDE.md", readers: ["claude"], pointer: false },
        { path: "CLAUDE.md", readers: ["claude"], pointer: true },
      ],
    };
    expect(skillSwitchNotice("claude", "codex", "Codex", report)).toBe(
      "This will not be visible to Codex: review, docs server, CLAUDE.md.",
    );
    expect(hiddenFromSentence(report, "review")).toBe("This will not be visible to Codex or Cursor.");
  });

  it("does not claim a CLI was checked when this report does not model it", () => {
    expect(skillSwitchNotice("claude", "grok", "Grok Build", shared)).toBe(
      "Hivra has not checked whether these skills travel to Grok Build.",
    );
    expect(skillSwitchNotice("grok", "claude", "Claude Code", shared)).toBeNull();
  });

  it("drops a late result for a project the person already left", () => {
    expect(acceptLoadedReport("C:/Repo", "c:/repo", shared)).toBe(shared);
    expect(acceptLoadedReport("C:/Repo", "C:/other", shared)).toBeNull();
  });

  it("treats a timeout as something to try again", () => {
    expect(readFailureNotice(new Error("timed out"))).toBe("Reading this project timed out. Try again.");
    expect(readFailureNotice(new Error("ENOENT"))).toBe("Could not read this project's files. Try again.");
    expect(readFailureNotice(new Error("timed out"))).toContain("Try again.");
  });
});

describe("toml and json configs", () => {
  it("skips a Codex server marked enabled false, including CRLF and comments", () => {
    const text = "[mcp_servers.off]\r\ncommand = 'node'\r\nenabled = false\r\n[mcp_servers.on]\r\ncommand = 'node'\r\n# enabled = false\r\n";
    expect(tomlMcpServers(text)).toEqual(["on"]);
  });
});

describe("memory fixtures", () => {
  it("reports a Windows project without calling a path outside it or the home folder", async () => {
    const project = "C:/repo/app";
    const home = "C:/Users/test";
    const { fs, calls } = memoryFs({
      "C:/repo/.git": "gitdir: C:/repo/git",
      "C:/repo/.mcp.json": JSON.stringify({ mcpServers: { "parent-docs": { command: "echo" }, gone: { disabled: true } } }),
      "C:/secret/.mcp.json": JSON.stringify({ mcpServers: { leak: { command: "echo" } }, token: "SECRET-ABOVE" }),
      "C:/repo/app/.agents/skills/review/SKILL.md": SKILL("review"),
      "C:/Users/test/.agents/skills/review/SKILL.md": "SECRET-HOME-COPY",
      "C:/repo/app/.codex/skills/review/SKILL.md": "SECRET-SHADOW",
      "C:/repo/app/.claude/skills/review-only/SKILL.md": SKILL("review-only"),
      "C:/repo/app/.cursor/rules/style.mdc": "use short sentences",
      "C:/repo/app/.cursor/rules/nested/skip.md": "no",
      "C:/repo/app/.cursor/rules/notes.txt": "no",
      "C:/Users/test/.claude.json": JSON.stringify({
        oauth: "SECRET-TOKEN",
        mcpServers: { docs: { command: "echo" } },
        projects: { "c:/repo/app": { mcpServers: { "local-docs": { command: "echo" } } } },
      }),
      "C:/Users/test/.claude/projects/chat.jsonl": "SECRET-SESSION",
      "C:/Users/test/.codex/config.toml": "[mcp_servers.docs]\nurl = 'https://example.com'\n",
    });
    const report = await loadParityReport(project, home, fs, "C:/");
    expect(report.skills.map((skill) => skill.name)).toEqual(["review", "review-only"]);
    expect(report.skills.find((skill) => skill.name === "review")).toMatchObject({
      path: ".agents/skills/review/SKILL.md",
      scope: "project",
    });
    expect(report.skills.find((skill) => skill.name === "review")?.readers).toEqual(
      expect.arrayContaining(["codex", "cursor"]),
    );
    expect(report.skills.find((skill) => skill.name === "review")?.readers).not.toContain("claude");
    expect(report.mcp.map((server) => `${server.cli}:${server.name}:${server.scope}`).sort()).toEqual([
      "claude:docs:user",
      "claude:local-docs:local",
      "claude:parent-docs:project",
      "codex:docs:user",
    ]);
    expect(report.mcp.find((server) => server.name === "parent-docs")?.path).toBe("../.mcp.json");
    expect(report.rules.map((rule) => rule.path)).toEqual([".cursor/rules/style.mdc"]);
    const dumped = JSON.stringify(report);
    expect(dumped).not.toContain("SECRET-");
    expect(dumped).not.toContain("/Users/");
    expect(dumped).not.toContain("C:/Users");
    expect(calls.some((call) => call.includes(".jsonl") || call.includes(".claude/projects") || call.includes("C:/secret"))).toBe(false);
  });

  it("ignores entry names that would climb out of the skill folder", async () => {
    const calls: string[] = [];
    const fs: ParityFs = {
      async list(dir) {
        calls.push(dir);
        if (dir.endsWith(".agents/skills")) {
          return [
            { name: "..", kind: "dir" },
            { name: "a/b", kind: "dir" },
            { name: ".hidden", kind: "dir" },
            { name: "skills-cursor", kind: "dir" },
            { name: "ok", kind: "dir" },
          ];
        }
        return null;
      },
      async readText(file) {
        calls.push(file);
        if (file.includes("..")) throw new Error(`climbed out: ${file}`);
        return file.endsWith("/ok/SKILL.md") ? SKILL("ok-skill") : null;
      },
      async readLink() {
        return null;
      },
    };
    const report = await loadParityReport("C:/repo", "C:/Users/test", fs, "C:/repo");
    expect(report.skills.map((skill) => skill.name)).toEqual(["ok-skill"]);
  });

  it("keeps the first 5000 skills", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5001; i++) files[`C:/repo/.claude/skills/n${i}/SKILL.md`] = SKILL(`n${i}`);
    const { fs } = memoryFs(files);
    const report = await loadParityReport("C:/repo", "C:/Users/test", fs, "C:/repo");
    const claudeOnly = report.skills.filter((skill) => skill.place === "claude");
    expect(claudeOnly).toHaveLength(5000);
    expect(claudeOnly.some((skill) => skill.name === "n5000")).toBe(false);
  });

  it("skips a broken MCP file, a turned-off plugin, and an install path outside the project and home", async () => {
    const { fs, calls } = memoryFs({
      "C:/repo/.mcp.json": "{ not json, token: SECRET-BROKEN",
      "C:/repo/.cursor/mcp.json": "{\n// note\n\"mcpServers\": { \"cursor-docs\": { \"command\": \"echo\" }, },}\n",
      "C:/Users/test/.claude/settings.local.json": JSON.stringify({ enabledPlugins: { "off@market": false } }),
      "C:/Users/test/.claude/plugins/installed_plugins.json": JSON.stringify({
        plugins: {
          "demo@market": [
            { scope: "user", installPath: "~/plugins/demo" },
            { scope: "user", installPath: "~/plugins/demo" },
          ],
          "off@market": [{ scope: "user", installPath: "/etc/off" }],
          "climb@market": [{ scope: "user", installPath: "../../../../../../etc/climb" }],
          "other@market": [{ scope: "project", projectPath: "/somewhere/else", installPath: "/etc/other" }],
          "Bad Name@market": [{ scope: "user", installPath: "/etc/bad" }],
        },
      }),
      "C:/Users/test/plugins/demo/skills/ship/SKILL.md": SKILL("ship"),
      "C:/etc/off/skills/nope/SKILL.md": "SECRET-PLUGIN",
    });
    const report = await loadParityReport("C:/repo", "C:/Users/test", fs, "C:/repo");
    expect(report.mcp.map((server) => server.name)).toEqual(["cursor-docs"]);
    expect(report.skills.map((skill) => skill.name)).toEqual(["demo:ship"]);
    expect(report.skills[0]?.readers).toEqual(["claude"]);
    expect(JSON.stringify(report)).not.toContain("SECRET-");
    expect(calls.some((call) => call.startsWith("/etc") || call.includes("C:/etc"))).toBe(false);
  });

  it("returns an empty report for an empty path and lets a timeout throw", async () => {
    const empty = await loadParityReport("", "C:/Users/test", memoryFs({}).fs);
    expect(empty).toEqual({ skills: [], mcp: [], rules: [] });
    const missing = await loadParityReport("C:/repo", "C:/Users/test", memoryFs({}).fs, "C:/repo");
    expect(missing).toEqual({ skills: [], mcp: [], rules: [] });
    const fs: ParityFs = {
      async readText() {
        throw new Error("The read timed out");
      },
      async list() {
        return [];
      },
      async readLink() {
        return null;
      },
    };
    await expect(loadParityReport("C:/repo", "C:/Users/test", fs, "C:/repo")).rejects.toThrow(/timed out/i);
  });
});

describe("fixture project folders", () => {
  const root = path.join(tmpdir(), `hivra-wp126-${process.pid}`);
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const project = path.join(repo, "app");
  let fs: ParityFs;
  const calls: string[] = [];

  function nodeFs(): ParityFs {
    const guard = (file: string) => {
      const normal = file.replace(/\\/g, "/");
      calls.push(normal);
      if (!normal.startsWith(root.replace(/\\/g, "/"))) throw new Error(`outside fixture: ${file}`);
    };
    return {
      async readText(file) {
        guard(file);
        try {
          return await readFile(file, "utf8");
        } catch {
          return null;
        }
      },
      async list(dir) {
        guard(dir);
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          return entries.map((entry) => ({
            name: entry.name,
            kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file",
          }));
        } catch {
          return null;
        }
      },
      async readLink(file) {
        guard(file);
        try {
          return await readlink(file);
        } catch {
          return null;
        }
      },
    };
  }

  async function write(file: string, text: string) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("reports Claude, Codex and Cursor from the folders those CLIs read", async () => {
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await write(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { leak: { command: "echo" } }, token: "SECRET-ABOVE" }));
    await write(path.join(repo, ".mcp.json"), JSON.stringify({
      mcpServers: { "parent-docs": { command: "echo" }, gone: { disabled: true } },
    }));
    await write(path.join(project, ".mcp.json"), "{ not json SECRET-BROKEN");
    await write(path.join(project, "AGENTS.md"), "Shared rules\n");
    await write(path.join(project, "CLAUDE.md"), "@AGENTS.md\r\n");
    await write(path.join(project, ".cursorrules"), "cursor root\n");
    await write(path.join(project, ".cursor/rules/style.mdc"), "style\n");
    await write(path.join(project, ".cursor/rules/nested/skip.md"), "no\n");
    await write(path.join(project, ".cursor/rules/notes.txt"), "no\n");
    await write(path.join(project, ".agents/skills/shared-review/SKILL.md"), SKILL("shared-review"));
    await write(path.join(project, ".agents/skills/my notes/SKILL.md"), SKILL("my-skill"));
    await write(path.join(project, ".agents/skills/ревью/SKILL.md"), "# only unicode\n");
    await write(path.join(project, ".claude/skills/review-only/SKILL.md"), SKILL("review-only"));
    await write(path.join(project, ".claude/skills/Bad Name/SKILL.md"), "# title\n");
    await write(path.join(project, ".claude/skills/skills-cursor/SKILL.md"), SKILL("ignored-cursor"));
    await write(
      path.join(project, ".codex/skills/other/skill.md"),
      "---\r\nname: crlf-skill\r\n---\r\n\r\n# Hi\r\n",
    );
    await write(path.join(project, ".codex/skills/shared-review/SKILL.md"), "SECRET-SHADOW");
    await write(path.join(project, ".cursor/skills/cursor-only/SKILL.md"), SKILL("cursor-only"));
    await write(path.join(project, ".codex/config.toml"), "[mcp_servers.off]\r\ncommand = 'node'\r\nenabled = false\r\n[mcp_servers.codex-docs]\r\ncommand = 'node'\r\n");
    await write(path.join(project, ".cursor/mcp.json"), "{\n// note\n\"mcpServers\": { \"cursor-docs\": { \"command\": \"echo\" }, },}\n");
    await mkdir(path.join(project, ".claude/skills"), { recursive: true });
    await symlink(
      path.relative(path.join(project, ".claude/skills"), path.join(project, ".agents/skills/shared-review")),
      path.join(project, ".claude/skills/shared-review"),
      "dir",
    );

    await write(path.join(home, ".claude.json"), JSON.stringify({
      oauth: "SECRET-TOKEN",
      mcpServers: { docs: { command: "echo" }, off: { command: "echo", enabled: false } },
      projects: { [project]: { mcpServers: { "local-docs": { command: "echo" } } } },
    }));
    await write(path.join(home, ".claude/CLAUDE.md"), "Only Claude\n");
    await write(path.join(home, ".claude/skills/home-only/SKILL.md"), SKILL("home-only"));
    await write(path.join(home, ".agents/skills/shared-review/SKILL.md"), "SECRET-HOME-COPY");
    await write(path.join(home, ".codex/skills/.system/system-skill/SKILL.md"), SKILL("system-skill"));
    await write(path.join(home, ".codex/config.toml"), "[mcp_servers.docs]\nurl = 'https://example.com'\n");
    await write(path.join(home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { "cursor-home": { command: "echo" } } }));
    await write(path.join(home, ".claude/projects/chat.jsonl"), "SECRET-SESSION");
    await write(path.join(home, ".claude/settings.local.json"), JSON.stringify({ enabledPlugins: { "off@market": false } }));
    await write(path.join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({
      plugins: {
        "demo@market": [{ scope: "user", installPath: "~/plugins/demo" }],
        "off@market": [{ scope: "user", installPath: "/etc/off" }],
        "climb@market": [{ scope: "user", installPath: "../../../../../../etc/climb" }],
      },
    }));
    await write(path.join(home, "plugins/demo/skills/ship/SKILL.md"), SKILL("ship"));

    fs = nodeFs();
    const report = await loadParityReport(project, home, fs, root);
    const names = report.skills.map((skill) => skill.name);
    expect(names).toEqual([
      "bad-name",
      "crlf-skill",
      "cursor-only",
      "demo:ship",
      "home-only",
      "my-skill",
      "review-only",
      "shared-review",
      "system-skill",
    ]);

    const shared = report.skills.find((skill) => skill.name === "shared-review");
    expect(shared).toMatchObject({ place: "agents", scope: "project", sharedFile: true, path: ".agents/skills/shared-review/SKILL.md" });
    expect(shared?.readers).toEqual(expect.arrayContaining(["claude", "codex", "cursor"]));
    expect(report.skills.filter((skill) => skill.name === "shared-review")).toHaveLength(1);
    expect(hiddenFromSentence(report, "shared-review")).toBeNull();
    expect(hiddenFromSentence(report, "review-only")).toBe("This will not be visible to Codex or Cursor.");
    expect(hiddenFromSentence(report, "my-skill")).toBe("This will not be visible to Claude Code.");

    expect(report.skills.find((skill) => skill.name === "my-skill")?.path).toBe(".agents/skills/my notes/SKILL.md");
    expect(report.skills.find((skill) => skill.name === "home-only")?.path).toBe("~/.claude/skills/home-only/SKILL.md");
    expect(report.skills.find((skill) => skill.name === "system-skill")?.path).toBe("~/.codex/skills/.system/system-skill/SKILL.md");
    expect(report.skills.find((skill) => skill.name === "demo:ship")?.readers).toEqual(["claude"]);

    expect(report.mcp.map((server) => `${server.cli}:${server.name}:${server.scope}`)).toEqual([
      "claude:docs:user",
      "claude:local-docs:local",
      "claude:parent-docs:project",
      "codex:codex-docs:project",
      "codex:docs:user",
      "cursor:cursor-docs:project",
      "cursor:cursor-home:user",
    ]);
    expect(report.mcp.find((server) => server.name === "parent-docs")?.path).toBe("../.mcp.json");

    expect(report.rules).toEqual([
      { path: "AGENTS.md", readers: ["claude", "codex", "cursor", "opencode", "pi"], pointer: false },
      { path: "CLAUDE.md", readers: ["claude"], pointer: true },
      { path: ".cursorrules", readers: ["cursor"], pointer: false },
      { path: ".cursor/rules/style.mdc", readers: ["cursor"], pointer: false },
      { path: "~/.claude/CLAUDE.md", readers: ["claude"], pointer: false },
    ]);

    const notice = skillSwitchNotice("claude", "codex", "Codex", report);
    expect(notice).toBe(
      "This will not be visible to Codex: bad-name, demo:ship, home-only, review-only, local-docs server, parent-docs server, ~/.claude/CLAUDE.md.",
    );
    expect(notice).not.toMatch(/[—–]/);
    expect(notice).not.toContain("shared-review");

    const dumped = JSON.stringify(report);
    expect(dumped).not.toContain("SECRET-");
    expect(dumped).not.toContain("/Users/");
    expect(dumped).not.toMatch(/[—–]/);
    expect(calls.some((call) => call.includes(".jsonl") || call.includes(`${root}/home/.claude/projects`) || call.includes("/etc"))).toBe(false);

    const linked = await lstat(path.join(project, ".claude/skills/shared-review"));
    expect(linked.isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("treats a CLAUDE.md link to AGENTS.md as the shared file", async () => {
    await mkdir(project, { recursive: true });
    await write(path.join(project, "AGENTS.md"), "Shared body\n");
    await symlink("AGENTS.md", path.join(project, "CLAUDE.md"));
    const report = await loadParityReport(project, home, nodeFs(), root);
    expect(report.rules.find((rule) => rule.path === "CLAUDE.md")).toMatchObject({ pointer: true, readers: ["claude"] });
    expect(skillSwitchNotice("claude", "codex", "Codex", report)).toBeNull();
  });
});

describe("path join used by the report", () => {
  it("resolves a relative link without keeping the dot segments", () => {
    expect(joinPath("/repo/app/.claude/skills", "../../.agents/skills/shared-review")).toBe(
      "/repo/app/.agents/skills/shared-review",
    );
  });
});
