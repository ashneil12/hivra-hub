// What autopilot may allow by itself when a supervised chat waits on a tool approval (Ash, 20 Oct): only
// - a read-only tool (Read, Grep, Glob, LS, WebSearch, WebFetch and the like);
// - a read-only MCP tool from a server the person installed through a Hivra plugin (mcpEffect.ts): every other
//   server's tools wait, because a hostile server can name a write tool like a read;
// - an edit or write whose files are all inside that chat's own folder (its worktree when it has one);
// - a shell command on a short list of reads, tests and builds (git status/diff/log/show/branch, ls, cat, rg, grep,
//   npm test / run check|lint|build, cargo test|check|clippy|fmt --check, node --test), with no chaining, substitution,
//   redirection or wildcard, and none of the options that make those tools run something else.
// Anything else waits for Ash exactly as when autopilot is off; the red list (redList.ts) is checked on top. It judges
// the provider's own request (`Block.approval.call`), never the transcript's label: a call that doesn't say exactly
// what it runs waits. An edit is checked twice: by its words (safeCall), then where it really lands (editStaysInside),
// with every folder on the way resolved through links by the app, so a link inside the folder (node_modules to the
// main checkout) doesn't carry it out.

import type { ApprovalCall } from "../../sessions/model/session";
import { isInstalledPluginServer, splitMcpTool, toolEffect } from "./mcpEffect";

/** Why a call isn't one autopilot may allow by itself, or null when it may. */
export type SafeVerdict = string | null;

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "WebSearch",
  "WebFetch",
  "BashOutput",
  "TodoRead",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

/**
 * Inside the chat's folder, these still wait: they change how git, the agent harnesses, hooks, editors or package
 * managers run commands, not just the project's files.
 */
const GUARDED_DIRS: ReadonlySet<string> = new Set([".git", ".claude", ".codex", ".cursor", ".husky", ".vscode", ".monocode", ".cargo", "node_modules"]);
const GUARDED_FILES: ReadonlySet<string> = new Set([".mcp.json", ".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".gitmodules"]);

/** A folder shallower than this (/, /Users, /Users/ash) is too broad to count as a chat's own. */
const MIN_FOLDER_DEPTH = 3;

/** An absolute POSIX path with ".", ".." and repeated slashes resolved; null when it isn't one or climbs past /. */
function normalize(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/** Whether an edit to `path` may go ahead in `folder`; why not otherwise. */
export function editInside(path: string, folder: string | undefined): SafeVerdict {
  const root = folder ? normalize(folder.replace(/\/+$/, "") || "/") : null;
  if (!root) return "the chat has no folder of its own to edit in";
  if (root.length < MIN_FOLDER_DEPTH) return "the chat's folder is too broad to edit in by itself";
  if (path.includes("\0") || path.startsWith("~")) return `it edits ${path}, outside the chat's folder`;
  const parts = normalize(path.startsWith("/") ? path : `/${root.join("/")}/${path}`);
  if (!parts || parts.length <= root.length || root.some((part, i) => parts[i] !== part))
    return `it edits ${path}, outside the chat's folder`;
  const inner = parts.slice(root.length);
  if (inner.some((part) => GUARDED_DIRS.has(part)) || GUARDED_FILES.has(inner[inner.length - 1]))
    return `it edits ${path}, which changes how tools run`;
  return null;
}

// ---- shell -------------------------------------------------------------------------------------------------------

/** Chaining, substitution, redirection, subshells, a newline: never allowed by itself, quoted or not. */
const SHELL_META = /[;&|`$<>()\n\r]/;

/** Characters a word may carry unquoted. Wildcards, braces, ^ and # can expand into other words (a file named
 * "--pre=sh" would become an option), so they must be quoted to count. */
const PLAIN = /[A-Za-z0-9_\-./:=,@%+~]/;

/**
 * The words the shell would pass, with quotes and backslashes as sh reads them. Null when it can't be read plainly: an
 * unclosed quote, or an unquoted character that could expand (a wildcard, a brace, ^ or #).
 */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\" && j + 1 < command.length && '"\\'.includes(command[j + 1])) j++;
        word += command[j];
      }
      if (j >= command.length) return null;
      inWord = true;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= command.length) return null;
      word += command[++i];
      inWord = true;
    } else if (c === " " || c === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else if (PLAIN.test(c)) {
      word += c;
      inWord = true;
    } else {
      return null;
    }
  }
  if (inWord) words.push(word);
  return words;
}

const has = (args: readonly string[], ...flags: string[]) =>
  args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));

const GIT_READS: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "branch"]);
/** `git branch` only lists: these options, and names only as what --list, --contains and the like look for. */
const BRANCH_LIST_FLAGS = /^(-a|--all|-r|--remotes|-v|-vv|--verbose|-l|--list|--show-current|--merged|--no-merged|--contains|--no-contains|--points-at|--sort(=.*)?|--format(=.*)?|--column|--no-column|--color(=.*)?|--no-color|--abbrev(=.*)?|--no-abbrev|-i|--ignore-case|--omit-empty)$/;
const BRANCH_QUERY = new Set(["-l", "--list", "--merged", "--no-merged", "--contains", "--no-contains", "--points-at"]);

function gitRead(args: readonly string[]): SafeVerdict {
  const [sub, ...rest] = args;
  if (!sub || !GIT_READS.has(sub)) return "only git status, diff, log, show and branch run by themselves";
  if (has(rest, "--output", "--ext-diff")) return "it writes a file or runs an outside diff";
  if (sub === "branch") {
    const flags = rest.filter((arg) => arg.startsWith("-"));
    if (flags.some((flag) => !BRANCH_LIST_FLAGS.test(flag))) return "git branch only lists by itself";
    if (rest.some((arg) => !arg.startsWith("-")) && !flags.some((flag) => BRANCH_QUERY.has(flag)))
      return "git branch only lists by itself";
  }
  return null;
}

const NPM_SCRIPTS = /^(test|check|lint|build)(:[\w.-]+)?$/;

function npmScript(args: readonly string[]): SafeVerdict {
  // npm test | npm run <test|check|lint|build>[:part], then only "--" and the script's own arguments: an npm option
  // (--prefix, --script-shell, -w) could run another folder's script or another shell.
  const [first, second, ...rest] = args;
  const after = first === "test" ? [second, ...rest].filter((a) => a !== undefined) : rest;
  const named = first === "test" || (first === "run" && !!second && NPM_SCRIPTS.test(second));
  if (!named) return "only npm test and npm run check, lint or build run by themselves";
  if (after.length && after[0] !== "--") return "npm options don't run by themselves";
  return null;
}

const CARGO_READS: ReadonlySet<string> = new Set(["test", "check", "clippy", "fmt"]);

function cargoRead(args: readonly string[]): SafeVerdict {
  const [sub, ...rest] = args;
  if (!sub || !CARGO_READS.has(sub)) return "only cargo test, check, clippy and fmt --check run by themselves";
  if (sub === "fmt" && !rest.includes("--check")) return "cargo fmt rewrites files unless it is --check";
  // --config can name a wrapper to run; the rest write outside the checkout or change files.
  if (has(rest, "--config", "--manifest-path", "--target-dir", "--artifact-dir", "--out-dir", "--fix", "--allow-dirty", "--allow-staged", "--emit") || rest.some((arg) => arg.startsWith("-Z")))
    return "that cargo option doesn't run by itself";
  return null;
}

function nodeTest(args: readonly string[]): SafeVerdict {
  if (!args.includes("--test")) return "only node --test runs by itself";
  if (has(args, "-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--experimental-loader", "-i", "--interactive", "--env-file", "--inspect", "--inspect-brk"))
    return "that node option doesn't run by itself";
  return null;
}

function rgRead(args: readonly string[]): SafeVerdict {
  // --pre runs a program on every file; --hostname-bin runs one too.
  return has(args, "--pre", "--pre-glob", "--hostname-bin") ? "rg --pre runs a program" : null;
}

const COMMANDS: Readonly<Record<string, (args: readonly string[]) => SafeVerdict>> = {
  git: gitRead,
  npm: npmScript,
  cargo: cargoRead,
  node: nodeTest,
  rg: rgRead,
  grep: () => null,
  ls: () => null,
  cat: () => null,
  head: () => null,
  tail: () => null,
  wc: () => null,
  pwd: () => null,
};

/** Whether a shell command is one autopilot may run by itself; why not otherwise. */
export function safeCommand(command: string): SafeVerdict {
  if (SHELL_META.test(command)) return "it chains, substitutes or redirects";
  const words = shellWords(command.trim());
  if (!words?.length) return "it can't be read plainly (a wildcard or an open quote)";
  const check = COMMANDS[words[0]];
  if (!check) return `${words[0]} isn't a read, test or build autopilot runs by itself`;
  return check(words.slice(1));
}

/** Whether a tool call is one autopilot may allow by itself in a chat working in `folder`; why not otherwise. */
export function safeCall(call: ApprovalCall | undefined, folder: string | undefined): SafeVerdict {
  if (!call) return "it doesn't say exactly what it runs";
  if (READ_ONLY_TOOLS.has(call.tool)) return null;
  if (EDIT_TOOLS.has(call.tool)) {
    if (!call.paths?.length) return "it doesn't say which file it edits";
    for (const path of call.paths) {
      const why = editInside(path, folder);
      if (why) return why;
    }
    return null;
  }
  if (SHELL_TOOLS.has(call.tool)) return call.command === undefined ? "it doesn't say what it runs" : safeCommand(call.command);
  const mcp = splitMcpTool(call.tool);
  if (mcp) {
    // A hostile server can name a write tool `get_x`, so a name alone only counts for a server the person installed
    // through Hivra's plugin flow. Every other server's tools wait, however they read.
    if (!isInstalledPluginServer(mcp.server)) return `${call.tool} comes from a server Hivra didn't install, so it waits for Ash`;
    const effect = toolEffect(mcp.tool);
    return effect === "read_only" ? null : `it is an MCP ${effect === "change" ? "change" : effect === "high_impact" ? "high-impact action" : "call autopilot can't place"}, so it waits for Ash`;
  }
  return `${call.tool} isn't a read, a test or build, or an edit in the chat's folder`;
}

// ---- where an edit really lands ----------------------------------------------------------------------------------

/** A path's checkout and its place in it, with the folders on the way resolved through links (fs.rs git_locate_files). */
export type RealPlace = { root: string; relative: string };
/** The app's lookup of real places; null for a path outside git. */
export type Locate = (paths: string[]) => Promise<(RealPlace | null)[]>;

/** A name looked up inside the chat's folder, so the lookup resolves the folder itself (it needn't exist). */
const PROBE = ".monocode-autopilot-probe";

const realPath = (place: RealPlace, relative = place.relative) =>
  relative ? `${place.root.replace(/\/+$/, "")}/${relative}` : place.root;

/**
 * Whether an edit the words allowed still lands inside the chat's folder once links are followed; why not otherwise.
 * Not an edit: nothing to check. A folder or file the app can't place (outside git, or the lookup failed) waits: a
 * file name that is itself a link isn't resolved by the lookup, which is why node_modules is held by name too.
 */
export async function editStaysInside(call: ApprovalCall | undefined, folder: string | undefined, locate: Locate): Promise<SafeVerdict> {
  if (!call || !EDIT_TOOLS.has(call.tool)) return null;
  const root = folder?.replace(/\/+$/, "");
  if (!root || !call.paths?.length) return "it doesn't say which file it edits";
  const targets = call.paths.map((path) => (path.startsWith("/") ? path : `${root}/${path}`));
  let places: (RealPlace | null)[];
  try {
    places = await locate([`${root}/${PROBE}`, ...targets]);
  } catch (error) {
    return `the app couldn't find where it really edits (${error instanceof Error ? error.message : String(error)})`;
  }
  const home = places[0];
  if (!home || !home.relative.endsWith(PROBE)) return "the app couldn't place the chat's folder in a git checkout";
  const realFolder = realPath(home, home.relative.slice(0, -PROBE.length).replace(/\/+$/, ""));
  for (let i = 0; i < targets.length; i++) {
    const place = places[i + 1];
    if (!place) return `the app couldn't place ${call.paths[i]} in a git checkout`;
    const why = editInside(realPath(place), realFolder);
    if (why) return why;
  }
  return null;
}
