#!/usr/bin/env node
// Hivra (11 Nov 2026): run only the tests a change can reach (test impact analysis), the default for every pull
// request and for an agent's own runs while it works.
//
// How a test is picked. The script reads every source under src/ and scripts/, follows their imports (static, dynamic,
// require, vi.mock, import.meta.glob, new URL(..., import.meta.url)) backwards from the changed files, and keeps each
// test file it reaches. A test that reads a file from disk instead of importing it is picked when its text names that
// file. `import type` and `export type` lines are skipped: a type reaches no running code, and tsc still checks every
// file on every run.
//
// When it runs everything. A change to what every test stands on (package.json, the lockfile, the vitest, vite or
// TypeScript config, the test setup, a .d.ts, the module aliases' stubs, CI itself or this script), a deleted source
// file, anything that isn't a pull request (a push to main, the nightly run, the pre-ship run) and any doubt (git
// failed, no base commit) run the whole suite: running too much is the safe mistake. Main's own run after every merge
// is still the full suite, so a knock-on effect this misses shows up there within one run, never at a ship.
//
//   node scripts/affected-tests.mjs plan                 # what it would run, as JSON
//   node scripts/affected-tests.mjs web [--shard=1/2]    # vitest on the picked web tests (all, some or none)
//   node scripts/affected-tests.mjs scripts              # node --test on the picked script tests
//   node scripts/affected-tests.mjs local                # npm run check:affected: both, tsc, and the Rust check when
//                                                        # a change reaches it; against origin/main (or --base <ref>),
//                                                        # uncommitted edits too
//
// In CI the changed files are the pull request's diff (the merge commit's first parent); locally they are the diff
// from the merge base with origin/main, plus staged, unstaged and untracked files.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { changeNeedsRust, parseNameStatus, readRustText } from "./ci-rust-changed.mjs";

/** A change to any of these can move every test's result, so the whole suite runs. */
export const RUN_EVERYTHING = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^vite\.config\.[cm]?[jt]s$/,
  /^tsconfig[^/]*\.json$/,
  /^src\/test\//,
  /^src\/features\/source-control\/testing\//, // the @pierre/diffs stubs vitest.config.ts aliases in
  /\.d\.ts$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/affected-tests\.mjs$/,
  /^scripts\/ci-rust-changed\.mjs$/,
];

/** The folders whose sources make up the import graph. */
export const GRAPH_ROOTS = ["src", "scripts"];

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const WEB_TEST = /^src\/.*\.test\.tsx?$/;
const SCRIPT_TEST = /^scripts\/(?:[^/]+\.test\.(?:cjs|mjs)|memory-eval\/[^/]+\.test\.mjs)$/;
const RESOLVE_EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"];

/** Basenames too common to say which file a test reads. */
const GENERIC_NAMES = new Set(["index.ts", "index.tsx", "index.js", "index.mjs", "mod.rs", "lib.rs", "main.rs", "README.md", "types.ts"]);

export const isWebTest = (file) => WEB_TEST.test(file);
export const isScriptTest = (file) => SCRIPT_TEST.test(file);

/**
 * The module specifiers a source names, each with whether it is a glob's folder. Type-only lines are left out.
 * @param {string} text
 * @returns {{ spec: string, glob: boolean }[]}
 */
export function specifiers(text) {
  const out = [];
  const add = (spec, glob = false) => {
    if (spec && spec.startsWith(".")) out.push({ spec, glob });
  };
  const runtime = text.replace(/^\s*(?:import|export)\s+type\b[^;]*?from\s*["'][^"']+["'];?/gms, "");
  const patterns = [
    /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/gs,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*["']([^"']+)["']/g,
    /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of runtime.matchAll(pattern)) add(match[1]);
  for (const match of runtime.matchAll(/\bimport\.meta\.glob(?:Eager)?\s*\(\s*(\[[^\]]*\]|["'][^"']+["'])/g)) {
    for (const quoted of match[1].matchAll(/["']([^"']+)["']/g)) {
      const pattern = quoted[1].replace(/^!/, "");
      const star = pattern.search(/[*{[]/);
      add(star === -1 ? pattern : pattern.slice(0, star).replace(/[^/]*$/, ""), true);
    }
  }
  return out;
}

/** Repo path of a specifier from `from`, or none when it leaves the repo or names no known file. */
export function resolveSpec(from, spec, known) {
  const clean = spec.replace(/[?#].*$/, "");
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
  if (joined.startsWith("..") || path.posix.isAbsolute(joined)) return undefined;
  for (const ext of RESOLVE_EXT) {
    const candidate = joined + ext;
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Who imports whom, reversed: for each file, the files that import it. A glob import is kept as a folder prefix.
 * @param {Map<string, string>} sources repo path to text, for every graph source
 * @param {Set<string>} known every tracked file
 */
export function reverseGraph(sources, known) {
  const importers = new Map();
  const globs = [];
  for (const [file, text] of sources) {
    for (const { spec, glob } of specifiers(text)) {
      if (glob) {
        const folder = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
        if (!folder.startsWith("..")) globs.push({ folder: folder.endsWith("/") ? folder : `${folder}/`, importer: file });
        continue;
      }
      const target = resolveSpec(file, spec, known);
      if (!target) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  return { importers, globs };
}

/** Every file that reaches one of `changed` through imports, the changed files included. */
export function reachedFrom(changed, graph) {
  const seen = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const file = queue.pop();
    const next = new Set(graph.importers.get(file) ?? []);
    for (const glob of graph.globs) if (file.startsWith(glob.folder)) next.add(glob.importer);
    for (const importer of next) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  return seen;
}

/** Tests whose text names a changed file it reads from disk (its repo path, or a basename that says which file). */
function namingTests(changed, tests, sources) {
  const picked = new Set();
  const needles = [];
  for (const file of changed) {
    needles.push(file);
    const base = path.posix.basename(file);
    if (!GENERIC_NAMES.has(base) && base.includes(".")) needles.push(base);
  }
  for (const test of tests) {
    const text = sources.get(test) ?? "";
    if (needles.some((needle) => text.includes(needle))) picked.add(test);
  }
  return picked;
}

/**
 * The plan for one set of changes.
 * @param {{ changes: { status: string, path: string }[], known: Set<string>, sources: Map<string, string> }} input
 * @returns {{ web: { mode: "all" | "some" | "none", tests: string[], reason: string }, scripts: { mode: "all" | "some" | "none", tests: string[], reason: string } }}
 */
export function planAffected({ changes, known, sources }) {
  const all = (reason) => ({ web: { mode: "all", tests: [], reason }, scripts: { mode: "all", tests: [], reason } });
  if (!changes.length) return all("no changed files were listed, so every test runs");
  for (const change of changes) {
    const file = change.path;
    if (file.startsWith("/") || file.includes("\\") || file.split("/").includes("..")) return all(`${file} is not a plain repo path`);
    const hit = RUN_EVERYTHING.find((pattern) => pattern.test(file));
    if (hit) return all(`${file} changes what every test stands on, so every test runs`);
    const deleted = change.status.startsWith("D");
    if (deleted && GRAPH_ROOTS.some((root) => file.startsWith(`${root}/`)) && CODE.test(file) && !isWebTest(file) && !isScriptTest(file)) {
      return all(`${file} was deleted, so every test runs (a test may still need it)`);
    }
  }
  const present = changes.filter((change) => !change.status.startsWith("D")).map((change) => change.path);
  const graph = reverseGraph(sources, known);
  const reached = reachedFrom(present, graph);
  const webTests = [...known].filter(isWebTest);
  const scriptTests = [...known].filter(isScriptTest);
  const named = namingTests(present, [...webTests, ...scriptTests], sources);
  const pick = (tests, label) => {
    const chosen = tests.filter((test) => reached.has(test) || named.has(test)).sort();
    return chosen.length
      ? { mode: "some", tests: chosen, reason: `${chosen.length} of ${tests.length} ${label} reach the ${present.length} changed file(s)` }
      : { mode: "none", tests: [], reason: `no ${label} reach the changed files` };
  };
  return { web: pick(webTests, "web test files"), scripts: pick(scriptTests, "script test files") };
}

// ---- reading the repo and git ----

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
}

export function readRepo(repo) {
  const known = new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], repo).split("\0").filter(Boolean));
  const sources = new Map();
  for (const file of known) {
    if (!GRAPH_ROOTS.some((root) => file.startsWith(`${root}/`)) || !CODE.test(file)) continue;
    try {
      sources.set(file, readFileSync(path.join(repo, file), "utf8"));
    } catch {
      // A file listed but gone (deleted in the working tree) imports nothing.
    }
  }
  return { known, sources };
}

/** The pull request's changes in CI: the merge commit against its first parent. */
export function prChanges(repo) {
  return parseNameStatus(git(["diff", "--name-status", "-z", "--no-renames", "HEAD^1", "HEAD"], repo));
}

/** A local branch's changes: committed since the merge base with `base`, plus staged, unstaged and untracked files. */
export function localChanges(repo, base) {
  const mergeBase = git(["merge-base", base, "HEAD"], repo).trim();
  const committed = parseNameStatus(git(["diff", "--name-status", "-z", "--no-renames", mergeBase], repo));
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"], repo)
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ status: "A", path: file }));
  const byPath = new Map();
  for (const change of [...committed, ...untracked]) byPath.set(change.path, change);
  return [...byPath.values()];
}

function planFor(repo, mode, base) {
  if (mode === "ci" && process.env.AFFECTED_EVENT !== "pull_request") {
    const reason = `not a pull request (${process.env.AFFECTED_EVENT || "no event"}), so every test runs`;
    return { web: { mode: "all", tests: [], reason }, scripts: { mode: "all", tests: [], reason } };
  }
  try {
    const changes = mode === "ci" ? prChanges(repo) : localChanges(repo, base);
    return planAffected({ changes, ...readRepo(repo) });
  } catch (error) {
    const reason = `the changed files could not be read, so every test runs (${error.message.split("\n")[0]})`;
    return { web: { mode: "all", tests: [], reason }, scripts: { mode: "all", tests: [], reason } };
  }
}

const SCRIPT_GLOBS = ["scripts/*.test.cjs", "scripts/*.test.mjs", "scripts/memory-eval/*.test.mjs"];

function run(command, args, repo) {
  process.stderr.write(`$ ${command} ${args.length > 12 ? `${args.slice(0, 12).join(" ")} … (${args.length} args)` : args.join(" ")}\n`);
  const result = spawnSync(command, args, { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
  return result.status ?? 1;
}

function runWeb(plan, repo, shard) {
  process.stderr.write(`web tests: ${plan.reason}\n`);
  if (plan.mode === "none") return 0;
  const args = ["vitest", "run", ...(shard ? [`--shard=${shard}`] : []), "--passWithNoTests", ...(plan.mode === "some" ? plan.tests : [])];
  return run("npx", args, repo);
}

function runScripts(plan, repo) {
  process.stderr.write(`script tests: ${plan.reason}\n`);
  if (plan.mode === "none") return 0;
  const files = plan.mode === "some" ? plan.tests : SCRIPT_GLOBS;
  return run(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...files], repo);
}

function main(argv) {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [command = "plan", ...rest] = argv;
  const option = (name) => {
    const inline = rest.find((arg) => arg.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const at = rest.indexOf(`--${name}`);
    return at === -1 ? undefined : rest[at + 1];
  };
  const local = command === "local" || rest.includes("--local");
  const base = option("base") ?? "origin/main";
  const plan = planFor(repo, local ? "local" : "ci", base);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  if (command === "web") return runWeb(plan.web, repo, option("shard"));
  if (command === "scripts") return runScripts(plan.scripts, repo);
  if (command === "local") {
    const web = runWeb(plan.web, repo);
    const scripts = runScripts(plan.scripts, repo);
    const types = run("npx", ["tsc", "--noEmit"], repo);
    let rust = 0;
    let rustChanged = true;
    try {
      const rustText = readRustText(repo);
      rustChanged = localChanges(repo, base).some((change) => changeNeedsRust(change, rustText));
    } catch {
      // Any doubt runs the Rust check.
    }
    if (rustChanged) rust = run("npm", ["run", "check:rust"], repo);
    else process.stderr.write("rust: nothing the Rust check reads changed, so it is skipped\n");
    return web || scripts || types || rust;
  }
  process.stderr.write(`unknown command ${command}: use plan, web, scripts or local\n`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
