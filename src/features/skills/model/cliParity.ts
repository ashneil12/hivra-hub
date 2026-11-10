// WP-126: what each CLI will load for one project.
//
// Skill folders match crates/monocode-core/src/skills.rs. MCP files match
// crates/monocode-core/src/mcp.rs. `.agents/skills` is the shared folder Codex,
// Cursor, OpenCode and Pi read (docs/hivra/plugins/README.md). Claude Code reads
// `.claude/skills` and its plugin skills, not that shared folder, unless the
// Claude skill is a link to the shared file. This module only reads those
// documented files. It does not read a CLI's session cache, and it never copies
// a skill into another CLI's folder.

import { isEqualOrInside, joinPath, parentPath, pathKey, slash } from "../../../shared/lib/paths";

export const PARITY_CLIS = ["claude", "codex", "cursor"] as const;
export type ParityCli = (typeof PARITY_CLIS)[number];

/** CLIs the plugins doc says read `.agents/skills`, plus the three the panel names. */
const SHARED_SKILL_READERS = ["codex", "cursor", "opencode", "pi"] as const;

export const CLI_LABEL: Record<ParityCli, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

export type SkillPlace = "agents" | "claude" | "codex" | "cursor" | "plugin";

export type FoundSkill = {
  name: string;
  /** Project-relative, or `~/...` for a skill in the home folder. Forward slashes. */
  path: string;
  scope: "project" | "user";
  place: SkillPlace;
  readers: string[];
  /** True when this is the one file in `.agents/skills`, not a second copy. */
  sharedFile: boolean;
};

export type FoundMcp = {
  cli: ParityCli;
  name: string;
  scope: "project" | "user" | "local";
  path: string;
};

export type FoundRule = {
  /** Project-relative, or `~/...` for a home file. */
  path: string;
  readers: string[];
  /** CLAUDE.md is only `@AGENTS.md`, so the body is the shared file. */
  pointer: boolean;
};

export type ParityReport = {
  skills: FoundSkill[];
  mcp: FoundMcp[];
  rules: FoundRule[];
};

export type DirKind = "dir" | "file" | "link";

export type ParityFs = {
  /** Null when the file is missing or unreadable. Not a final failure. */
  readText(path: string): Promise<string | null>;
  /** Null when the folder is missing or unreadable. */
  list(path: string): Promise<{ name: string; kind: DirKind }[] | null>;
  /** Null when the path is not a link. */
  readLink(path: string): Promise<string | null>;
};

const EMPTY: ParityReport = { skills: [], mcp: [], rules: [] };
const MAX_SKILLS = 5_000;
const MAX_TEXT = 1_000_000;
const PANEL_CLIS: readonly ParityCli[] = PARITY_CLIS;

export function asParityCli(id: string): ParityCli | null {
  return (PANEL_CLIS as readonly string[]).includes(id) ? (id as ParityCli) : null;
}

/** A late read for a project the person has already left is dropped. */
export function acceptLoadedReport<T>(requested: string, current: string, value: T): T | null {
  return pathKey(slash(requested)) === pathKey(slash(current)) ? value : null;
}

/** A timeout or a miss is something to try again, not a final failure. */
export function readFailureNotice(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/timeout|timed out/i.test(message)) return "Reading this project timed out. Try again.";
  return "Could not read this project's files. Try again.";
}

const FRONTMATTER_PREFIX = 16 * 1024;

export function skillNameFromMarkdown(text: string, folder: string): string | null {
  const named = frontmatterName(text.slice(0, FRONTMATTER_PREFIX));
  if (named && isValidSkillName(named)) return named;
  const fallback = slugName(folder);
  return isValidSkillName(fallback) ? fallback : null;
}

/**
 * Skills, servers and rule files `from` loads that `to` will not.
 * Null when everything `from` loads also loads for `to`.
 * `toLabel` is the name shown for a CLI this report does not model.
 */
export function skillSwitchNotice(
  from: string,
  to: string,
  toLabel: string,
  report: ParityReport,
): string | null {
  if (from === to) return null;
  const source = asParityCli(from);
  const target = asParityCli(to);
  if (!source || !target) {
    const owned = report.skills.some((skill) => skill.readers.includes(from));
    return owned
      ? `Hivra has not checked whether these skills travel to ${toLabel}.`
      : null;
  }
  const dropped: string[] = [];
  const seen = new Set<string>();
  const push = (label: string) => {
    if (seen.has(label)) return;
    seen.add(label);
    dropped.push(label);
  };
  const targetNames = new Set(
    report.skills.filter((skill) => skill.readers.includes(target)).map((skill) => skill.name),
  );
  for (const skill of report.skills) {
    if (!skill.readers.includes(source) || targetNames.has(skill.name)) continue;
    push(skill.name);
  }
  for (const server of report.mcp) {
    if (server.cli !== source) continue;
    const travels = report.mcp.some((other) => other.cli === target && other.name === server.name);
    if (!travels) push(`${server.name} server`);
  }
  for (const rule of report.rules) {
    if (rule.pointer || !rule.readers.includes(source) || rule.readers.includes(target)) continue;
    push(rule.path);
  }
  if (dropped.length === 0) return null;
  return `This will not be visible to ${CLI_LABEL[target]}: ${dropped.join(", ")}.`;
}

export type SkillCopy = { from: string; to: string };

/**
 * Files this package would write so another CLI can see a skill.
 * A skill already in `.agents/skills` is the shared file. Nothing is copied
 * into a CLI folder, and no new skill file type is introduced.
 */
export function skillCopyPlan(report: ParityReport): SkillCopy[] {
  const copies: SkillCopy[] = [];
  for (const skill of report.skills) {
    const path = skill.path.replace(/\\/g, "/");
    const shared = skill.sharedFile || path.includes(".agents/skills/");
    if (!shared) continue;
    // Codex, Cursor, OpenCode and Pi already read this file. A second body
    // under `.codex/skills` or `.cursor/skills` would be a different file.
  }
  return copies;
}

/** CLIs in the panel that will not load a skill of this name. */
export function skillHiddenFrom(report: ParityReport, name: string): ParityCli[] {
  return PANEL_CLIS.filter(
    (cli) => !report.skills.some((skill) => skill.name === name && skill.readers.includes(cli)),
  );
}

export function hiddenFromSentence(report: ParityReport, name: string): string | null {
  const missing = skillHiddenFrom(report, name);
  if (missing.length === 0) return null;
  const labels = missing.map((cli) => CLI_LABEL[cli]);
  if (labels.length === 1) return `This will not be visible to ${labels[0]}.`;
  const head = labels.slice(0, -1).join(", ");
  return `This will not be visible to ${head} or ${labels[labels.length - 1]}.`;
}

export async function loadParityReport(
  project: string,
  home: string,
  fs: ParityFs,
  ceiling?: string,
): Promise<ParityReport> {
  const root = slash(project).replace(/\/+$/, "");
  const userHome = slash(home).replace(/\/+$/, "");
  if (!root || root === "." || !userHome) return EMPTY;
  const skills = await collectSkills(root, userHome, fs);
  const mcp = await collectMcp(root, userHome, fs, ceiling);
  const rules = await collectRules(root, userHome, fs);
  return { skills, mcp, rules };
}

async function collectSkills(project: string, home: string, fs: ParityFs): Promise<FoundSkill[]> {
  const found: FoundSkill[] = [];
  const byReal = new Map<string, FoundSkill>();
  const seenName = new Set<string>();

  const add = (skill: FoundSkill, real: string) => {
    if (found.length >= MAX_SKILLS) return;
    const key = `${skill.name}\0${skill.readers.join(",")}`;
    if (seenName.has(key)) return;
    seenName.add(key);
    found.push(skill);
    byReal.set(pathKey(real), skill);
  };

  const claimShared = (real: string, reader: string) => {
    const skill = byReal.get(pathKey(real));
    if (!skill) return false;
    if (!skill.readers.includes(reader)) skill.readers.push(reader);
    skill.sharedFile = true;
    return true;
  };

  const scanRoot = async (
    dir: string,
    scope: "project" | "user",
    place: SkillPlace,
    readers: string[],
  ) => {
    if (!allowed(dir, project, home)) return;
    const entries = await fs.list(dir);
    if (!entries) return;
    for (const entry of entries) {
      if (found.length >= MAX_SKILLS) return;
      if (!oneSegment(entry.name) || entry.name.startsWith(".") || entry.name === "skills-cursor") continue;
      const folder = joinPath(dir, entry.name);
      if (!allowed(folder, project, home)) continue;
      if (entry.kind === "link") {
        const linked = await linkTarget(folder, fs);
        if (!linked || !allowed(linked, project, home)) continue;
        const shared = sharedSkillFolder(linked, project, home);
        if (shared && claimShared(shared, readers[0] ?? "claude")) continue;
      }
      const file = await skillFile(folder, fs);
      if (!file) continue;
      const text = await readCapped(fs, file);
      if (text == null) continue;
      const name = skillNameFromMarkdown(text, entry.name);
      if (!name) continue;
      const already = readers.every((reader) =>
        found.some((skill) => skill.name === name && skill.readers.includes(reader)),
      );
      if (already) continue;
      add(
        {
          name,
          path: displayPath(file, project, home),
          scope,
          place,
          readers: [...readers],
          sharedFile: place === "agents",
        },
        folder,
      );
    }
  };

  await scanRoot(joinPath(project, ".agents/skills"), "project", "agents", [...SHARED_SKILL_READERS]);
  await scanRoot(joinPath(home, ".agents/skills"), "user", "agents", [...SHARED_SKILL_READERS]);
  await scanRoot(joinPath(project, ".claude/skills"), "project", "claude", ["claude"]);
  await scanRoot(joinPath(home, ".claude/skills"), "user", "claude", ["claude"]);
  await scanRoot(joinPath(project, ".codex/skills"), "project", "codex", ["codex"]);
  await scanRoot(joinPath(home, ".codex/skills"), "user", "codex", ["codex"]);
  await scanRoot(joinPath(joinPath(home, ".codex/skills"), ".system"), "user", "codex", ["codex"]);
  await scanRoot(joinPath(project, ".cursor/skills"), "project", "cursor", ["cursor"]);
  await scanRoot(joinPath(home, ".cursor/skills"), "user", "cursor", ["cursor"]);
  await scanPlugins(project, home, fs, add);
  found.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return found;
}

async function scanPlugins(
  project: string,
  home: string,
  fs: ParityFs,
  add: (skill: FoundSkill, real: string) => void,
): Promise<void> {
  const registry = joinPath(home, ".claude/plugins/installed_plugins.json");
  if (!allowed(registry, project, home)) return;
  const text = await readCapped(fs, registry);
  if (!text) return;
  const parsed = parseJsonLoose(text);
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== "object") return;
  for (const [id, installed] of Object.entries(plugins as Record<string, unknown>)) {
    const at = id.lastIndexOf("@");
    const namespace = at === -1 ? id : id.slice(0, at);
    if (!isValidSkillName(namespace)) continue;
    if (await pluginTurnedOff(id, project, home, fs)) continue;
    const entries = Array.isArray(installed) ? installed : installed && typeof installed === "object" ? [installed] : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const scope = record.scope === "project" || record.scope === "local" ? "project" : record.scope === "user" || record.scope == null ? "user" : null;
      if (!scope) continue;
      if (scope === "project") {
        const projectPath = typeof record.projectPath === "string" ? expandHome(record.projectPath, home) : "";
        if (!projectPath || !isEqualOrInside(project, projectPath)) continue;
      }
      const install = typeof record.installPath === "string" ? expandHome(record.installPath, home) : "";
      if (!install || !allowed(install, project, home)) continue;
      const skillsDir = joinPath(install, "skills");
      if (!allowed(skillsDir, project, home)) continue;
      const listed = await fs.list(skillsDir);
      if (!listed) continue;
      for (const item of listed) {
        if (!oneSegment(item.name) || item.name.startsWith(".")) continue;
        const folder = joinPath(skillsDir, item.name);
        if (!allowed(folder, project, home)) continue;
        if (item.kind === "link") {
          const linked = await linkTarget(folder, fs);
          if (!linked || !allowed(linked, project, home)) continue;
        }
        const file = await skillFile(folder, fs);
        if (!file) continue;
        const body = await readCapped(fs, file);
        if (body == null) continue;
        const leaf = skillNameFromMarkdown(body, item.name);
        if (!leaf) continue;
        const name = `${namespace}:${leaf}`;
        add(
          {
            name,
            path: displayPath(file, project, home),
            scope,
            place: "plugin",
            readers: ["claude"],
            sharedFile: false,
          },
          folder,
        );
      }
    }
  }
}

/** First explicit enabledPlugins value wins, matching the skill scanner. */
async function pluginTurnedOff(id: string, project: string, home: string, fs: ParityFs): Promise<boolean> {
  for (const path of [
    joinPath(project, ".claude/settings.local.json"),
    joinPath(project, ".claude/settings.json"),
    joinPath(home, ".claude/settings.json"),
  ]) {
    if (!allowed(path, project, home)) continue;
    const text = await readCapped(fs, path);
    if (!text) continue;
    const parsed = parseJsonLoose(text);
    const enabled = parsed?.enabledPlugins;
    if (!enabled || typeof enabled !== "object" || Array.isArray(enabled)) continue;
    const value = (enabled as Record<string, unknown>)[id];
    if (typeof value === "boolean") return !value;
  }
  return false;
}

async function collectMcp(
  project: string,
  home: string,
  fs: ParityFs,
  ceiling?: string,
): Promise<FoundMcp[]> {
  const found: FoundMcp[] = [];
  const dirs = await projectDirs(project, home, fs, ceiling);
  const readable = (path: string) =>
    allowed(path, project, home) || dirs.some((dir) => isEqualOrInside(path, dir));
  const pushJson = async (
    cli: ParityCli,
    scope: FoundMcp["scope"],
    path: string,
    key: string,
    projectKey?: string,
  ) => {
    if (!readable(path)) return;
    const text = await readCapped(fs, path);
    if (!text) return;
    const parsed = parseJsonLoose(text);
    if (!parsed) return;
    let block: unknown = parsed[key];
    if (projectKey) {
      const projects = parsed.projects;
      if (!projects || typeof projects !== "object") return;
      const match = Object.entries(projects as Record<string, unknown>).find(
        ([dir]) => pathKey(slash(dir)) === pathKey(project),
      );
      const entry = match?.[1];
      if (!entry || typeof entry !== "object") return;
      block = (entry as Record<string, unknown>)[key];
    }
    for (const server of serversFromBlock(block)) {
      found.push({ cli, name: server, scope, path: displayPath(path, project, home) });
    }
  };

  await pushJson("claude", "user", joinPath(home, ".claude.json"), "mcpServers");
  await pushJson("claude", "local", joinPath(home, ".claude.json"), "mcpServers", project);
  await pushJson("cursor", "user", joinPath(home, ".cursor/mcp.json"), "mcpServers");
  for (const dir of dirs) {
    await pushJson("claude", "project", joinPath(dir, ".mcp.json"), "mcpServers");
    await pushJson("cursor", "project", joinPath(dir, ".cursor/mcp.json"), "mcpServers");
    await pushToml("codex", "project", joinPath(dir, ".codex/config.toml"));
  }
  await pushToml("codex", "user", joinPath(home, ".codex/config.toml"));

  async function pushToml(cli: ParityCli, scope: FoundMcp["scope"], path: string) {
    if (!readable(path)) return;
    const text = await readCapped(fs, path);
    if (!text) return;
    for (const name of tomlMcpServers(text)) {
      found.push({ cli, name, scope, path: displayPath(path, project, home) });
    }
  }

  found.sort((a, b) => a.cli.localeCompare(b.cli) || a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  return found;
}

async function collectRules(project: string, home: string, fs: ParityFs): Promise<FoundRule[]> {
  const rules: FoundRule[] = [];
  const agents = joinPath(project, "AGENTS.md");
  if (await readCapped(fs, agents) != null) {
    rules.push({ path: "AGENTS.md", readers: ["claude", "codex", "cursor", "opencode", "pi"], pointer: false });
  }
  const claude = joinPath(project, "CLAUDE.md");
  const claudeLink = await fs.readLink(claude);
  const claudeText = await readCapped(fs, claude);
  if (claudeText != null) {
    const pointer = isAgentsPointer(claudeText) || (claudeLink != null && linkIsAgents(claude, claudeLink));
    rules.push({ path: "CLAUDE.md", readers: ["claude"], pointer });
  }
  const cursorrules = joinPath(project, ".cursorrules");
  if (await readCapped(fs, cursorrules) != null) {
    rules.push({ path: ".cursorrules", readers: ["cursor"], pointer: false });
  }
  const rulesDir = joinPath(project, ".cursor/rules");
  const listed = await fs.list(rulesDir);
  if (listed) {
    for (const entry of listed) {
      if (entry.kind === "dir" || !oneSegment(entry.name)) continue;
      if (!/\.(?:md|mdc)$/i.test(entry.name)) continue;
      rules.push({ path: `.cursor/rules/${entry.name}`, readers: ["cursor"], pointer: false });
    }
  }
  const userClaude = joinPath(home, ".claude/CLAUDE.md");
  if (await readCapped(fs, userClaude) != null) {
    rules.push({ path: displayPath(userClaude, project, home), readers: ["claude"], pointer: false });
  }
  return rules;
}

function serversFromBlock(block: unknown): string[] {
  if (!block || typeof block !== "object" || Array.isArray(block)) return [];
  const names: string[] = [];
  for (const [name, config] of Object.entries(block as Record<string, unknown>)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    if (!serverNameOk(name)) continue;
    const record = config as Record<string, unknown>;
    if (record.enabled === false || record.disabled === true) continue;
    names.push(name);
  }
  return names;
}

/** Dotted Codex tables: `[mcp_servers.name]`. `enabled = false` drops that server. */
export function tomlMcpServers(text: string): string[] {
  const enabled = new Map<string, boolean>();
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    const header = /^\[\s*mcp_servers\.([^\]\s]+)\s*\]/.exec(line);
    if (header) {
      current = tomlKey(header[1] ?? "");
      if (current && !enabled.has(current)) enabled.set(current, true);
      continue;
    }
    if (/^\[/.test(line)) {
      current = null;
      continue;
    }
    if (current && /^\s*enabled\s*=\s*false\b/.test(line)) enabled.set(current, false);
  }
  return [...enabled.entries()].filter(([, on]) => on).map(([name]) => name).sort();
}

function stripTomlComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

function tomlKey(raw: string): string {
  const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw);
  const name = (quoted?.[1] ?? raw).trim();
  return serverNameOk(name) ? name : "";
}

function serverNameOk(name: string): boolean {
  return name.length > 0 && name.length <= 128 && !/[\u0000-\u001f]/.test(name);
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const clean = text.replace(/^﻿/, "");
  try {
    const value = JSON.parse(clean) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    // Documented configs are JSON. A comment or a trailing comma still counts.
  }
  try {
    const value = JSON.parse(stripJsonc(clean)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stripJsonc(raw: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? "";
    if (quoted) {
      out += ch;
      if (ch === "\\") {
        out += raw[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      out += ch;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function isAgentsPointer(text: string): boolean {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length === 1 && lines[0] === "@AGENTS.md";
}

function linkIsAgents(file: string, target: string): boolean {
  const resolved = target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)
    ? slash(target)
    : joinPath(parentPath(file), target);
  return /(?:^|\/)AGENTS\.md$/.test(resolved);
}

function frontmatterName(text: string): string | null {
  const trimmed = text.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) return null;
  let rest = trimmed.slice(3);
  if (rest.startsWith("\r\n")) rest = rest.slice(2);
  else if (rest.startsWith("\n") || rest.startsWith("\r")) rest = rest.slice(1);
  const end = rest.search(/\r?\n---/);
  const yaml = end === -1 ? rest : rest.slice(0, end);
  for (const raw of yaml.split(/\r?\n/)) {
    const match = /^name:\s*(.*?)\s*$/.exec(raw);
    if (!match) continue;
    const value = (match[1] ?? "").replace(/^["']|["']$/g, "").trim();
    return value || null;
  }
  return null;
}

function isValidSkillName(name: string): boolean {
  if (!name || name.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i] ?? "";
    if (/[a-z0-9]/.test(ch)) {
      prevDash = false;
      continue;
    }
    if (ch === "-" && i > 0 && !prevDash) {
      prevDash = true;
      continue;
    }
    return false;
  }
  return !prevDash;
}

function slugName(raw: string): string {
  let out = "";
  let dash = false;
  for (const ch of raw) {
    if (/[A-Za-z0-9]/.test(ch)) {
      out += ch.toLowerCase();
      dash = false;
    } else if (out && !dash) {
      out += "-";
      dash = true;
    }
  }
  out = out.replace(/-+$/, "");
  if (out.length > 64) out = out.slice(0, 64).replace(/-+$/, "");
  return out;
}

async function skillFile(folder: string, fs: ParityFs): Promise<string | null> {
  for (const name of ["SKILL.md", "skill.md"]) {
    const path = joinPath(folder, name);
    const text = await fs.readText(path);
    if (text != null) return path;
  }
  return null;
}

async function linkTarget(path: string, fs: ParityFs): Promise<string | null> {
  const target = await fs.readLink(path);
  if (!target) return null;
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) return slash(target);
  return joinPath(parentPath(path), target);
}

function sharedSkillFolder(folder: string, project: string, home: string): string | null {
  const normal = slash(folder).replace(/\/+$/, "");
  const roots = [joinPath(project, ".agents/skills"), joinPath(home, ".agents/skills")];
  const inside = roots.some((root) => isEqualOrInside(normal, root) && pathKey(normal) !== pathKey(root));
  return inside ? normal : null;
}

async function readCapped(fs: ParityFs, path: string): Promise<string | null> {
  const text = await fs.readText(path);
  if (text == null) return null;
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

function oneSegment(name: string): boolean {
  return !!name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

function allowed(path: string, project: string, home: string): boolean {
  return isEqualOrInside(path, project) || isEqualOrInside(path, home);
}

function displayPath(path: string, project: string, home: string): string {
  const normal = slash(path);
  const fromProject = relativeInside(normal, project);
  if (fromProject != null) return fromProject;
  const fromHome = relativeInside(normal, home);
  if (fromHome != null) return fromHome === "." ? "~" : `~/${fromHome}`;
  const above = ancestorRelative(normal, project);
  return above ?? ".";
}

function relativeInside(path: string, root: string): string | null {
  const file = slash(path).replace(/\/+$/, "") || "/";
  const base = slash(root).replace(/\/+$/, "") || "/";
  if (pathKey(file) === pathKey(base)) return ".";
  if (!isEqualOrInside(file, base)) return null;
  return file.slice(base.length).replace(/^\/+/, "");
}

/** `../.mcp.json` when the file sits in a parent of the project. Never an absolute path. */
function ancestorRelative(path: string, project: string): string | null {
  const file = slash(path).replace(/\/+$/, "") || "/";
  const base = slash(project).replace(/\/+$/, "") || "/";
  const dir = parentPath(file);
  if (!isEqualOrInside(base, dir)) return null;
  const rest = relativeInside(base, dir);
  const name = file.slice(dir === "/" ? 1 : dir.length).replace(/^\/+/, "");
  if (!name) return null;
  if (rest == null || rest === ".") return name;
  const ups = rest.split("/").filter(Boolean).map(() => "..").join("/");
  return `${ups}/${name}`;
}

function expandHome(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return joinPath(home, raw.slice(2));
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return slash(raw);
  return joinPath(home, raw);
}

async function projectDirs(project: string, home: string, fs: ParityFs, ceiling?: string): Promise<string[]> {
  const dirs: string[] = [];
  let current = slash(project).replace(/\/+$/, "");
  for (let i = 0; i < 40; i++) {
    if (pathKey(current) === pathKey(home)) break;
    if (ceiling && !isEqualOrInside(current, ceiling) && pathKey(current) !== pathKey(slash(ceiling))) break;
    dirs.push(current);
    const gitDir = await fs.list(joinPath(current, ".git"));
    const gitFile = gitDir ? null : await fs.readText(joinPath(current, ".git"));
    if (gitDir || gitFile != null) break;
    const parent = parentPath(current);
    if (parent === current || pathKey(parent) === pathKey(home)) break;
    if (ceiling && pathKey(parent) === pathKey(slash(ceiling).replace(/\/+$/, ""))) break;
    if (ceiling && !isEqualOrInside(parent, ceiling)) break;
    current = parent;
  }
  return dirs;
}
