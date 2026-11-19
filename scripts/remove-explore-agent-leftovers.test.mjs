// The one-off clean-up for WP-143's first build (scripts/remove-explore-agent-leftovers.mjs): it matches only the
// files that build wrote, byte for byte, and never touches a file a person edited or one git tracks.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appProjectFolders,
  findLeftovers,
  firstBuildAgentFile,
  main,
  matchFirstBuild,
  removeLeftovers,
} from "./remove-explore-agent-leftovers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "remove-explore-agent-leftovers.mjs");

// Written out here on purpose, as the first build wrote them, so a change to the generator can't move the target.
const EXPLORE_HAIKU = [
  "---",
  "name: Explore",
  "description: Read-only search of this project. Use this to find files and answer questions about the code.",
  "tools: Read, Grep, Glob, Bash",
  "model: haiku",
  "---",
  "",
  "Search and read only. Do not edit files, and do not change the project.",
  "",
].join("\n");
const PLAN_HAIKU = [
  "---",
  "name: Plan",
  "description: Read-only planning for this project. Use this to design an approach before any edits.",
  "tools: Read, Grep, Glob, Bash",
  "model: haiku",
  "---",
  "",
  "Plan only. Do not edit files, and do not change the project.",
  "",
].join("\n");

const temps = [];
function scratch() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "explore-leftovers-")));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function git(dir, ...args) {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  put(path.join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

/** A `.claude/agents` pair the way the first build left it in `folder`. */
function leftovers(folder) {
  put(path.join(folder, ".claude/agents/Explore.md"), EXPLORE_HAIKU);
  put(path.join(folder, ".claude/agents/Plan.md"), PLAN_HAIKU);
}

const noHome = (dir) => ({ home: path.join(dir, "home"), env: {} });

test("the generator writes exactly the bytes the first build did", () => {
  assert.equal(firstBuildAgentFile("Explore", "haiku"), EXPLORE_HAIKU);
  assert.equal(firstBuildAgentFile("Plan", "haiku"), PLAN_HAIKU);
  // A worker's own model id (the off-Anthropic case) is one plain line.
  assert.match(firstBuildAgentFile("Explore", "grok-4.6"), /\nmodel: grok-4\.6\n---\n/);
  assert.throws(() => firstBuildAgentFile("Explore", "has space"));
  assert.throws(() => firstBuildAgentFile("Reviewer", "haiku"));
});

test("only the first build's exact files match", () => {
  assert.deepEqual(matchFirstBuild("Explore.md", EXPLORE_HAIKU), { name: "Explore", model: "haiku" });
  assert.deepEqual(matchFirstBuild("Plan.md", PLAN_HAIKU), { name: "Plan", model: "haiku" });
  const other = firstBuildAgentFile("Explore", "grok-4.6");
  assert.deepEqual(matchFirstBuild("Explore.md", other), { name: "Explore", model: "grok-4.6" });
});

test("a file edited by even one character is not matched", () => {
  const edits = {
    "a changed body": EXPLORE_HAIKU.replace("Search and read only.", "Search and read only!"),
    "an extra line": `${EXPLORE_HAIKU}Also run the tests.\n`,
    "an extra frontmatter line": EXPLORE_HAIKU.replace("model: haiku\n", "model: haiku\ncolor: red\n"),
    "a changed description": EXPLORE_HAIKU.replace("find files", "find every file"),
    "another tools line": EXPLORE_HAIKU.replace("Read, Grep, Glob, Bash", "Read, Grep, Glob"),
    "no final newline": EXPLORE_HAIKU.slice(0, -1),
    "CRLF line ends": EXPLORE_HAIKU.replaceAll("\n", "\r\n"),
    "a trailing space": EXPLORE_HAIKU.replace("model: haiku", "model: haiku "),
    "a model with a space": EXPLORE_HAIKU.replace("model: haiku", "model: my model"),
    "an empty model": EXPLORE_HAIKU.replace("model: haiku", "model: "),
    "no model line": EXPLORE_HAIKU.replace("model: haiku\n", ""),
    "two model lines": EXPLORE_HAIKU.replace("model: haiku\n", "model: haiku\nmodel: opus\n"),
    "a leading blank line": `\n${EXPLORE_HAIKU}`,
    "the Plan name": EXPLORE_HAIKU.replace("name: Explore", "name: Plan"),
    "an emptied file": "",
  };
  for (const [what, text] of Object.entries(edits)) {
    assert.equal(matchFirstBuild("Explore.md", text), null, what);
  }
  // Right text, wrong file name; and other file names with the right text.
  assert.equal(matchFirstBuild("Plan.md", EXPLORE_HAIKU), null);
  assert.equal(matchFirstBuild("Explore.md", PLAN_HAIKU), null);
  for (const name of ["explore.md", "Explorer.md", "Explore.markdown", "Explore.md.bak", "Reviewer.md"]) {
    assert.equal(matchFirstBuild(name, EXPLORE_HAIKU), null, name);
  }
  assert.equal(matchFirstBuild("Explore.md", undefined), null);
});

test("finds untracked leftovers in a repository and in a plain folder, and names them", () => {
  const dir = scratch();
  repo(path.join(dir, "Worktrees/hub-x"));
  leftovers(path.join(dir, "Worktrees/hub-x"));
  leftovers(path.join(dir, "Worktrees/plain"));
  // A session that worked in a sub-folder of a project.
  leftovers(path.join(dir, "Worktrees/hub-x/packages/app"));
  const { found, scanned } = findLeftovers({ roots: [path.join(dir, "Worktrees")], ...noHome(dir) });
  assert.equal(found.length, 6);
  assert.ok(found.every((item) => item.state === "untracked"), JSON.stringify(found));
  assert.ok(scanned >= 5);
  assert.deepEqual(
    found.map((item) => `${path.relative(dir, item.file)}:${item.name}:${item.model}`),
    [
      "Worktrees/hub-x/.claude/agents/Explore.md:Explore:haiku",
      "Worktrees/hub-x/.claude/agents/Plan.md:Plan:haiku",
      "Worktrees/hub-x/packages/app/.claude/agents/Explore.md:Explore:haiku",
      "Worktrees/hub-x/packages/app/.claude/agents/Plan.md:Plan:haiku",
      "Worktrees/plain/.claude/agents/Explore.md:Explore:haiku",
      "Worktrees/plain/.claude/agents/Plan.md:Plan:haiku",
    ],
  );
});

test("a user-edited file is not found, and neither is anything else in the folder", () => {
  const dir = scratch();
  const project = path.join(dir, "Worktrees/p");
  put(path.join(project, ".claude/agents/Explore.md"), EXPLORE_HAIKU.replace("haiku", "haiku\ncolor: red"));
  put(path.join(project, ".claude/agents/Plan.md"), PLAN_HAIKU);
  put(path.join(project, ".claude/agents/reviewer.md"), "---\nname: Reviewer\n---\n");
  put(path.join(project, ".claude/settings.json"), "{}\n");
  const { found } = findLeftovers({ roots: [path.join(dir, "Worktrees")], ...noHome(dir) });
  assert.deepEqual(found.map((item) => path.basename(item.file)), ["Plan.md"]);
});

test("a copy git tracks is listed as tracked, and removal leaves it alone", () => {
  const dir = scratch();
  const project = repo(path.join(dir, "Worktrees/committed"));
  leftovers(project);
  git(project, "add", ".claude");
  git(project, "commit", "-q", "-m", "crews committed the files");
  // Plan is tracked, Explore was removed from the index only: still on disk and untracked.
  git(project, "rm", "-q", "--cached", ".claude/agents/Explore.md");
  const { found } = findLeftovers({ roots: [path.join(dir, "Worktrees")], ...noHome(dir) });
  const byName = Object.fromEntries(found.map((item) => [item.name, item.state]));
  assert.deepEqual(byName, { Explore: "untracked", Plan: "tracked" });

  const result = removeLeftovers(found);
  assert.deepEqual(result.removed, [path.join(project, ".claude/agents/Explore.md")]);
  assert.ok(fs.existsSync(path.join(project, ".claude/agents/Plan.md")));
  // Its folders stay because the tracked file is in them.
  assert.ok(fs.existsSync(path.join(project, ".claude/agents")));
  assert.equal(fs.readFileSync(path.join(project, ".claude/agents/Plan.md"), "utf8"), PLAN_HAIKU);
  assert.equal(git(project, "ls-files", ".claude").trim(), ".claude/agents/Plan.md");
});

test("removal deletes the untracked files, then empty .claude/agents and .claude, and nothing else", () => {
  const dir = scratch();
  const project = repo(path.join(dir, "Worktrees/clean"));
  leftovers(project);
  assert.ok(git(project, "status", "--porcelain").includes("?? .claude/"));
  const { found } = findLeftovers({ roots: [path.join(dir, "Worktrees")], ...noHome(dir) });
  const result = removeLeftovers(found);
  assert.equal(result.removed.length, 2);
  assert.deepEqual(result.kept, []);
  assert.equal(fs.existsSync(path.join(project, ".claude")), false);
  assert.equal(git(project, "status", "--porcelain"), "");
  assert.ok(fs.existsSync(path.join(project, "README.md")));

  // Another agent file keeps `.claude/agents`; another file in `.claude` keeps `.claude`.
  const busy = path.join(dir, "Worktrees/busy");
  leftovers(busy);
  put(path.join(busy, ".claude/agents/reviewer.md"), "---\nname: Reviewer\n---\n");
  const quiet = path.join(dir, "Worktrees/quiet");
  leftovers(quiet);
  put(path.join(quiet, ".claude/settings.json"), "{}\n");
  removeLeftovers(findLeftovers({ roots: [path.join(dir, "Worktrees")], ...noHome(dir) }).found);
  assert.deepEqual(fs.readdirSync(path.join(busy, ".claude/agents")), ["reviewer.md"]);
  assert.deepEqual(fs.readdirSync(path.join(quiet, ".claude")), ["settings.json"]);
});

test("a file changed between the scan and the delete is kept", () => {
  const dir = scratch();
  const project = path.join(dir, "Worktrees/race");
  leftovers(project);
  const { found } = findLeftovers({ roots: [path.join(dir, "Worktrees")], ...noHome(dir) });
  put(path.join(project, ".claude/agents/Explore.md"), `${EXPLORE_HAIKU}my own line\n`);
  const result = removeLeftovers(found);
  assert.deepEqual(result.removed, [path.join(project, ".claude/agents/Plan.md")]);
  assert.equal(result.kept.length, 1);
  assert.match(result.kept[0].why, /changed since the scan/);
  assert.ok(fs.existsSync(path.join(project, ".claude/agents/Explore.md")));
});

test("the person's own ~/.claude is never looked into, and links are never followed", () => {
  const dir = scratch();
  const home = path.join(dir, "home");
  // The same bytes in the home Claude folder are the person's own file.
  put(path.join(home, ".claude/agents/Explore.md"), EXPLORE_HAIKU);
  const inHome = findLeftovers({ roots: [home], folders: [home], home, env: {} });
  assert.deepEqual(inHome.found, []);
  // A config folder named by the environment is the person's own too.
  const config = path.join(dir, "elsewhere");
  put(path.join(config, "agents/Explore.md"), EXPLORE_HAIKU);
  const viaEnv = findLeftovers({ folders: [config], home, env: { CLAUDE_CONFIG_DIR: path.join(config, "agents", "..") } });
  assert.deepEqual(viaEnv.found, []);

  // A link to a folder with a leftover is not walked, so what it points at is not reached through it.
  const real = path.join(dir, "outside/real");
  leftovers(real);
  const roots = path.join(dir, "roots");
  fs.mkdirSync(roots);
  fs.symlinkSync(real, path.join(roots, "linked"));
  assert.deepEqual(findLeftovers({ roots: [roots], home, env: {} }).found, []);
  // A `.claude/agents` that is itself a link is not read.
  const other = path.join(dir, "roots/proj");
  fs.mkdirSync(path.join(other, ".claude"), { recursive: true });
  fs.symlinkSync(path.join(real, ".claude/agents"), path.join(other, ".claude/agents"));
  assert.deepEqual(findLeftovers({ roots: [roots], home, env: {} }).found, []);
});

test("heavy folders are skipped and the walk stops at the depth limit", () => {
  const dir = scratch();
  const root = path.join(dir, "Worktrees");
  leftovers(path.join(root, "p/node_modules/pkg"));
  leftovers(path.join(root, "p/target/debug"));
  leftovers(path.join(root, "a/b/c/d/e/f/g/h"));
  assert.deepEqual(findLeftovers({ roots: [root], ...noHome(dir) }).found, []);
  assert.equal(findLeftovers({ roots: [root], maxDepth: 8, ...noHome(dir) }).found.length, 2);
});

test("git that can't answer means unknown, and unknown is never deleted", () => {
  const dir = scratch();
  const project = path.join(dir, "Worktrees/unsure");
  leftovers(project);
  const { found } = findLeftovers({ roots: [path.join(dir, "Worktrees")], state: () => "unknown", ...noHome(dir) });
  assert.equal(found.length, 2);
  const result = removeLeftovers(found);
  assert.deepEqual(result.removed, []);
  assert.ok(fs.existsSync(path.join(project, ".claude/agents/Explore.md")));
});

function run(args, extra = {}) {
  const lines = [];
  const errors = [];
  const code = main(args, { out: (line) => lines.push(line), err: (line) => errors.push(line), ...extra });
  return { code, text: lines.join("\n"), errors: errors.join("\n") };
}

test("the command is a dry run unless --yes: it lists, deletes nothing and says so", () => {
  const dir = scratch();
  const root = path.join(dir, "Worktrees");
  repo(path.join(root, "one"));
  leftovers(path.join(root, "one"));
  const tracked = repo(path.join(root, "two"));
  leftovers(tracked);
  git(tracked, "add", ".claude/agents/Plan.md");
  git(tracked, "commit", "-q", "-m", "tracked");
  const before = git(path.join(root, "one"), "status", "--porcelain");

  const dry = run(["--no-default-roots", "--root", root], noHome(dir));
  assert.equal(dry.code, 0, dry.errors);
  assert.match(dry.text, /dry run, nothing is deleted/);
  assert.match(dry.text, /would delete {2}.*one\/\.claude\/agents\/Explore\.md {2}\(Explore, model haiku, untracked\)/);
  assert.match(dry.text, /would delete {2}.*two\/\.claude\/agents\/Explore\.md/);
  assert.match(dry.text, /Tracked by git, left alone/);
  assert.match(dry.text, /git -C ".*two" rm -- \.claude\/agents\/Plan\.md/);
  assert.match(dry.text, /4 found: 3 untracked \(would be deleted with --yes\), 1 tracked, 0 unknown\./);
  assert.match(dry.text, /Nothing was changed\./);
  assert.equal(git(path.join(root, "one"), "status", "--porcelain"), before);
  assert.ok(fs.existsSync(path.join(root, "one/.claude/agents/Explore.md")));

  const yes = run(["--no-default-roots", "--root", root, "--yes"], noHome(dir));
  assert.equal(yes.code, 0, yes.errors);
  assert.match(yes.text, /Deleted 3 files, removed 2 empty folders\./);
  assert.equal(fs.existsSync(path.join(root, "one/.claude")), false);
  assert.ok(fs.existsSync(path.join(tracked, ".claude/agents/Plan.md")));
  assert.equal(git(tracked, "ls-files", ".claude").trim(), ".claude/agents/Plan.md");
});

test("the default roots are ~/Worktrees and ~/Projects, read from the home it is given", () => {
  const dir = scratch();
  const home = path.join(dir, "home");
  leftovers(path.join(home, "Worktrees/a"));
  leftovers(path.join(home, "Projects/b"));
  leftovers(path.join(home, "Documents/c"));
  const result = run([], { home, env: {} });
  assert.equal(result.code, 0);
  assert.match(result.text, /Worktrees\/a\/\.claude\/agents\/Explore\.md/);
  assert.match(result.text, /Projects\/b\/\.claude\/agents\/Plan\.md/);
  assert.doesNotMatch(result.text, /Documents/);
  assert.match(result.text, /4 found: 4 untracked/);
});

test("bad arguments fail with the usage and change nothing", () => {
  for (const args of [["--nope"], ["--root"], ["--max-depth", "x"], ["--root", "--yes"]]) {
    const result = run(args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.errors, /Usage:/);
  }
  assert.equal(run(["--help"]).code, 0);
});

test("run as a script it prints the dry run and exits 0 without --yes", () => {
  const dir = scratch();
  leftovers(path.join(dir, "Worktrees/x"));
  const result = spawnSync(process.execPath, [script, "--no-default-roots", "--root", path.join(dir, "Worktrees")], {
    encoding: "utf8",
    env: { ...process.env, HOME: path.join(dir, "home") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would delete/);
  assert.ok(fs.existsSync(path.join(dir, "Worktrees/x/.claude/agents/Explore.md")));
});

const hasSqlite = spawnSync("sqlite3", ["-version"]).status === 0;

test("--app-projects reads the folders chats ran in from a database copy, and only reads it", { skip: !hasSqlite }, () => {
  const dir = scratch();
  const db = path.join(dir, "monocode.db");
  const worked = path.join(dir, "elsewhere/proj");
  leftovers(worked);
  execFileSync("sqlite3", [
    db,
    `CREATE TABLE sessions (id TEXT, cwd TEXT); INSERT INTO sessions VALUES ('a', '${worked}'), ('b', '${worked}'), ('c', 'remote://host/x'), ('d', 'relative/dir');`,
  ]);
  const before = fs.readFileSync(db);
  assert.deepEqual(appProjectFolders(db), [worked]);
  const result = run(["--no-default-roots", "--app-projects", db], noHome(dir));
  assert.equal(result.code, 0, result.errors);
  assert.match(result.text, /elsewhere\/proj\/\.claude\/agents\/Explore\.md/);
  assert.deepEqual(fs.readFileSync(db), before);
  assert.notEqual(run(["--no-default-roots", "--app-projects", path.join(dir, "missing.db")], noHome(dir)).code, 0);
});
