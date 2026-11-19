#!/usr/bin/env node
// One-off clean-up for WP-143's first build. That build wrote `.claude/agents/Explore.md` and `Plan.md` into the
// folder every crew or Mono session worked in. Those files dirty `git status` (which blocks `hub:ship`, worktree
// removal and auto clean-up), an untracked `Explore.md` counts as "the person's own Explore" so the cheap Explore
// flag is skipped, and a leftover `Plan.md` still pins Plan to a cheap model. The fixed build writes nothing; this
// removes what the first one left.
//
//   node scripts/remove-explore-agent-leftovers.mjs                  # dry run: lists what it would do, deletes nothing
//   node scripts/remove-explore-agent-leftovers.mjs --yes            # delete the untracked leftovers
//   node scripts/remove-explore-agent-leftovers.mjs --root <dir>     # also look under <dir> (repeatable)
//   node scripts/remove-explore-agent-leftovers.mjs --app-projects <monocode.db>
//                                                                    # also look in every folder a chat of the app ran
//                                                                    # in (read from a COPY of the app's database; the
//                                                                    # file is only read, via `sqlite3 -readonly`)
//   node scripts/remove-explore-agent-leftovers.mjs --no-default-roots   # only the --root and --app-projects folders
//
// Default roots: ~/Worktrees and ~/Projects.
//
// A file is a leftover only when it is `Explore.md` or `Plan.md` in a `.claude/agents` folder and its bytes are exactly
// what the first build wrote (`exploreAgentFile` in commit d50f0e60: the name, the two fixed descriptions, the fixed
// tools line, one plain `model:` line and the one-line body). A file a person edited by even one character is not
// matched and is never touched. A copy git tracks is listed with the `git rm` to run, never deleted here. After the
// delete, `.claude/agents` and then `.claude` are removed only if they are empty. Nothing under the home `.claude`
// folder is looked at. Nothing is ever deleted without --yes.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The two descriptions and bodies the first build wrote, word for word. */
const DESCRIPTION = {
  Explore: "Read-only search of this project. Use this to find files and answer questions about the code.",
  Plan: "Read-only planning for this project. Use this to design an approach before any edits.",
};
const BODY = {
  Explore: "Search and read only. Do not edit files, and do not change the project.",
  Plan: "Plan only. Do not edit files, and do not change the project.",
};
/** The first build refused any model id outside this. */
const SAFE_MODEL = /^[A-Za-z0-9._-]{1,120}$/;

const FILE_NAMES = { "Explore.md": "Explore", "Plan.md": "Plan" };

/** The exact text the first build wrote (`exploreAgentFile` in commit d50f0e60). */
export function firstBuildAgentFile(name, model) {
  if (!(name in DESCRIPTION)) throw new Error(`Not a first-build agent: ${name}`);
  if (!SAFE_MODEL.test(model)) throw new Error("Not a model id the first build wrote.");
  return [
    "---",
    `name: ${name}`,
    `description: ${DESCRIPTION[name]}`,
    "tools: Read, Grep, Glob, Bash",
    `model: ${model}`,
    "---",
    "",
    BODY[name],
    "",
  ].join("\n");
}

/**
 * `{ name, model }` when `text` is, byte for byte, what the first build wrote for a file called `fileName`;
 * otherwise null. Anything else, edited or not, is not matched.
 */
export function matchFirstBuild(fileName, text) {
  const name = FILE_NAMES[fileName];
  if (!name || typeof text !== "string") return null;
  const model = /^model: (.*)$/m.exec(text)?.[1];
  if (model === undefined || !SAFE_MODEL.test(model)) return null;
  return text === firstBuildAgentFile(name, model) ? { name, model } : null;
}

/** Folders never entered: not a place a session works in, and the big ones cost minutes to walk. */
const SKIP = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".gradle",
  "Pods",
  "DerivedData",
]);

const DEFAULT_MAX_DEPTH = 6;

function isRealDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sameFolder(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** The person's own Claude folders, which this never looks into. */
function userClaudeDirs(home, env) {
  const dirs = [path.join(home, ".claude")];
  if (env.CLAUDE_CONFIG_DIR) dirs.push(env.CLAUDE_CONFIG_DIR);
  return dirs;
}

/** The first-build files in `<folder>/.claude/agents`, as `[{ file, name, model }]`. */
function leftoversIn(folder, home, env) {
  const claude = path.join(folder, ".claude");
  const agents = path.join(claude, "agents");
  if (!isRealDir(claude) || !isRealDir(agents)) return [];
  if (userClaudeDirs(home, env).some((dir) => sameFolder(claude, dir))) return [];
  const out = [];
  for (const fileName of Object.keys(FILE_NAMES)) {
    const file = path.join(agents, fileName);
    let text;
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const hit = matchFirstBuild(fileName, text);
    if (hit) out.push({ file, ...hit });
  }
  return out;
}

/**
 * Whether git tracks `file`: "tracked", "untracked" (in a repository that doesn't know it, or in no repository), or
 * "unknown" when git could not say. Only "untracked" is ever deleted.
 */
function trackedState(file) {
  const result = spawnSync("git", ["-C", path.dirname(file), "ls-files", "--error-unmatch", "--", path.basename(file)], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  if (result.error) return "unknown";
  if (result.status === 0) return "tracked";
  if (result.status === 1) return "untracked";
  if (result.status === 128 && /not a git repository/i.test(result.stderr ?? "")) return "untracked";
  return "unknown";
}

/**
 * Every first-build leftover under `roots` (walked, to `maxDepth`, never through a link) and in each of `folders`
 * (only that folder's own `.claude/agents`): `{ found: [{ file, name, model, state }], scanned }`.
 */
export function findLeftovers({
  roots = [],
  folders = [],
  home = os.homedir(),
  env = process.env,
  maxDepth = DEFAULT_MAX_DEPTH,
  state = trackedState,
} = {}) {
  const seen = new Set();
  const found = [];
  let scanned = 0;
  const add = (folder) => {
    for (const hit of leftoversIn(folder, home, env)) {
      if (seen.has(hit.file)) continue;
      seen.add(hit.file);
      found.push({ ...hit, state: state(hit.file) });
    }
  };
  const walk = (dir, depth) => {
    scanned += 1;
    add(dir);
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
      // The agents folder was read with its project; there is nothing else in it to walk.
      if (entry.name === "agents" && path.basename(dir) === ".claude") continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) {
    if (isRealDir(root)) walk(path.resolve(root), 0);
  }
  for (const folder of folders) {
    scanned += 1;
    add(path.resolve(folder));
  }
  found.sort((a, b) => a.file.localeCompare(b.file));
  return { found, scanned };
}

/** Folders chats of the app ran in, from a copy of its database (`sessions.cwd`). Read only. */
export function appProjectFolders(dbPath) {
  const result = spawnSync("sqlite3", ["-readonly", "-batch", dbPath, "SELECT DISTINCT cwd FROM sessions"], {
    encoding: "utf8",
  });
  if (result.error) throw new Error(`sqlite3 is needed to read ${dbPath}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`sqlite3 could not read ${dbPath}: ${(result.stderr ?? "").trim()}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => path.isAbsolute(line));
}

function rmdirIfEmpty(dir) {
  if (!isRealDir(dir)) return false;
  try {
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the untracked leftovers in `found`. Each is read and matched again just before it goes, so a file edited
 * since the scan is kept. Then `.claude/agents` and `.claude` go if empty. Returns what happened.
 */
export function removeLeftovers(found) {
  const removed = [];
  const kept = [];
  const folders = [];
  for (const item of found) {
    if (item.state !== "untracked") continue;
    let text;
    try {
      text = fs.readFileSync(item.file, "utf8");
    } catch {
      kept.push({ file: item.file, why: "could not be read again" });
      continue;
    }
    if (!matchFirstBuild(path.basename(item.file), text)) {
      kept.push({ file: item.file, why: "changed since the scan" });
      continue;
    }
    try {
      fs.unlinkSync(item.file);
      removed.push(item.file);
    } catch (error) {
      kept.push({ file: item.file, why: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const agents = path.dirname(item.file);
    const claude = path.dirname(agents);
    if (rmdirIfEmpty(agents)) folders.push(agents);
    if (path.basename(claude) === ".claude" && rmdirIfEmpty(claude)) folders.push(claude);
  }
  return { removed, kept, folders };
}

function parseArgs(argv) {
  const options = { yes: false, roots: [], appProjects: [], defaultRoots: true, maxDepth: DEFAULT_MAX_DEPTH, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--yes") options.yes = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-default-roots") options.defaultRoots = false;
    else if (arg === "--root") options.roots.push(value());
    else if (arg === "--app-projects") options.appProjects.push(value());
    else if (arg === "--max-depth") {
      const depth = Number(value());
      if (!Number.isInteger(depth) || depth < 0) throw new Error("--max-depth needs a whole number");
      options.maxDepth = depth;
    } else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

const USAGE = `Usage: node scripts/remove-explore-agent-leftovers.mjs [--yes] [--root DIR]... [--app-projects DB]... [--no-default-roots] [--max-depth N]
Dry run unless --yes. Default roots: ~/Worktrees and ~/Projects.`;

/** The command. `io` stands in for the process in tests. Returns the exit code. */
export function main(argv, io = {}) {
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  const home = io.home ?? os.homedir();
  const env = io.env ?? process.env;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err(USAGE);
    return 1;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  const roots = [...(options.defaultRoots ? [path.join(home, "Worktrees"), path.join(home, "Projects")] : []), ...options.roots];
  let folders = [];
  try {
    for (const db of options.appProjects) folders = folders.concat(appProjectFolders(db));
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const { found, scanned } = findLeftovers({ roots, folders, home, env, maxDepth: options.maxDepth });
  const untracked = found.filter((item) => item.state === "untracked");
  const tracked = found.filter((item) => item.state === "tracked");
  const unknown = found.filter((item) => item.state === "unknown");

  out(`First-build Explore and Plan agent files (WP-143): ${options.yes ? "DELETING" : "dry run, nothing is deleted"}`);
  out(`Looked in ${scanned} folders: ${[...roots, ...folders.map((folder) => `${folder} (app)`)].join(", ") || "none"}`);
  out("");
  for (const item of untracked) out(`${options.yes ? "delete" : "would delete"}  ${item.file}  (${item.name}, model ${item.model}, untracked)`);
  if (tracked.length > 0) {
    out("");
    out("Tracked by git, left alone. Remove each in its own repository with git rm, then commit:");
    for (const item of tracked) {
      const agents = path.dirname(item.file);
      out(`  git -C ${JSON.stringify(path.dirname(path.dirname(agents)))} rm -- .claude/agents/${path.basename(item.file)}`);
    }
  }
  if (unknown.length > 0) {
    out("");
    out("Git could not say whether these are tracked, left alone:");
    for (const item of unknown) out(`  ${item.file}`);
  }

  let code = 0;
  if (options.yes && untracked.length > 0) {
    const result = removeLeftovers(found);
    out("");
    out(`Deleted ${result.removed.length} files, removed ${result.folders.length} empty folders.`);
    for (const item of result.kept) {
      out(`Kept ${item.file} (${item.why})`);
      code = 1;
    }
  }
  out("");
  out(
    `${found.length} found: ${untracked.length} untracked${options.yes ? "" : " (would be deleted with --yes)"}, ${tracked.length} tracked, ${unknown.length} unknown.`,
  );
  if (!options.yes && untracked.length > 0) out("Nothing was changed. Run again with --yes to delete the untracked ones.");
  return code;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
