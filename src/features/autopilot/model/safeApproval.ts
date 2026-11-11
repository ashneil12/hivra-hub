// What autopilot may allow by itself when a supervised chat waits on a tool approval (Ash, 20 Oct): only
// - a read-only tool (Read, Grep, Glob, LS and the like), whose paths are checked as paths: a search must start inside
//   the chat's folder, and a file in a login store waits;
// - a read-only MCP tool or resource from a server the person installed through a Hivra plugin (mcpEffect.ts), with
//   arguments that name no path, URL or host: every other server's tools wait, because a hostile server can name a
//   write tool like a read;
// - an edit or write whose files are all inside that chat's own folder (its worktree when it has one), and no
//   protected name (.claude, .mcp.json, CLAUDE.md, AGENTS.md) whatever its case or form;
// - a shell command on a short list of reads (git status/diff/log/show/branch, ls, cat, rg, grep, find, fd, tree,
//   stat, du, df, file, which, ps, wc, head, tail, cargo fmt --check), with no chaining, substitution, redirection or
//   wildcard, and none of the options that make those tools write a file, follow a link or run something else.
// Tests and builds (npm test, npm run check, cargo test, node --test) are not on that list: each runs code the chat
// may have just written, so they wait for Ash (review C1).
// Anything else waits for Ash exactly as when autopilot is off; the red list (redList.ts) is checked on top. It judges
// the provider's own request (`Block.approval.call`), never the transcript's label: a call that doesn't say exactly
// what it runs waits. An edit is checked twice: by its words (safeCall), then where it really lands (editStaysInside),
// with every folder on the way resolved through links by the app, so a link inside the folder (node_modules to the
// main checkout) doesn't carry it out.

import type { ApprovalCall } from "../../sessions/model/session";
import { credentialInWords, credentialPath, dotOutside, foldedFolder, timerOutside, walkHeld } from "./credentialPaths";
import { guardRunHeld, isProtectedConfig, segmentsOf } from "./protectedConfig";
import { splitMcpTool, toolEffect } from "./mcpEffect";
import { serverTrusted, type TrustedServers } from "./mcpTrust";
import { shellWords } from "./shellWords";

/** Why a call isn't one autopilot may allow by itself, or null when it may. */
export type SafeVerdict = string | null;

/**
 * Read-only tools that name a file or folder (or nothing). WebFetch is not here: it sends its URL, so it always waits
 * (review H3). The MCP resource tools are not here either: they go to a named server, so they are judged as MCP calls.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebSearch", "BashOutput", "TodoRead"]);
/** Search tools, whose paths are where a walk starts (review H1). */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob", "LS"]);
/** MCP resource tools: the server is their `server` input, and only a server Hivra wired is trusted (review M3). */
const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set(["ListMcpResourcesTool", "ReadMcpResourceTool"]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

/**
 * Inside the chat's folder, these still wait: they change how git, the agent harnesses, hooks, editors or package
 * managers run commands, not just the project's files. Names are compared folded (case, width and invisible
 * characters), since the Mac disk is case-insensitive and a name can be written in another form (review H4).
 */
// The config of the agent harnesses (OpenCode, omp, pi, Grok, Gemini, Cursor rules, Codex overrides) and of the tools that
// run on every commit or in every shell (mise, lefthook, lint-staged, pnpm, bun, rust toolchain, git hooks) is held, and
// so is every dot-named folder or file the tools read skills and settings from. The list is shared with the Rust timer
// check (protectedConfig.ts; review round 3, item 1). A hijacked worker writing an MCP command into opencode.jsonc would
// run it in the next OpenCode chat with no tap.

/** A name as a file system that ignores case and form compares it: NFKC, no invisible characters, lower case. */
export function foldName(name: string): string {
  return name.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase();
}

/** A folder shallower than this (/, /Users, /Users/someone) is too broad to count as a chat's own. */
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
  if (isProtectedConfig(inner)) return `it edits ${path}, which changes how tools run`;
  // Round 5, L1: the guard's own source, matched on the whole path so the chat's own folder can't hide it.
  if (guardRunHeld(parts)) return `it edits ${path}, which is the approval guard itself`;
  return null;
}

/**
 * The files a read-only tool names (the Read tool's `file_path`), as the provider gave them, for the credential check
 * (credentialPaths.ts credentialInPaths). An edit's files are not here: its rule is `editInside`. The value is not
 * trusted to be a list of text, so it is returned as it came and the check holds what it can't read.
 */
export function readPaths(call: ApprovalCall | undefined): unknown {
  if (!call || typeof call.tool !== "string" || !READ_ONLY_TOOLS.has(call.tool)) return undefined;
  return call.paths;
}

/**
 * A string that names a place: a path, a home folder, an address, or a host ("evil.example", "x.y/z", "https://"). A
 * climb (`..`) is a place too.
 */
const NAMES_PLACE = /[\\/~]|\w\.\w|:\/\/|\.\./;
/** A scheme at the start ("http:", "file:", "mailto:"): an address however it is written (review round 3, item 4). */
const SCHEME = /^[a-z][\w+.-]*:/i;
/** The loopback name, as a word of its own: `localhost`, `x.localhost` (round 4, item 6). */
const LOOPBACK = /(^|[^a-z0-9])localhost($|[^a-z0-9])/i;
/** An IPv6 address or a bracketed host (`::1`, `[::1]`) (round 5, L2). */
const IPV6_HOST = /::|\[|\]/;
/** An address written as one number (`16909060` is 1.2.3.4) or in hex: an IP however it is spelled (round 4, item 6). */
const NUMERIC_HOST = /^(\d{8,}|0\d+|0x[0-9a-f]+)$/i;

/**
 * An argument as a name reads once the look-alikes are folded (round 4, item 6): NFKC (fullwidth `．`), the ideographic
 * full stops (U+3002 and the halfwidth U+FF61, which NFKC does not fold to a dot), and percent-encoded dots, slashes and
 * backslashes, decoded again while they keep appearing.
 */
function plainName(value: string): string {
  let text = value.normalize("NFKC").replace(/[\u3002\uFF61]/g, ".");
  for (let i = 0; i < 4 && /%(25|2e|2f|5c)/i.test(text); i++) {
    text = text.replace(/%25/gi, "%").replace(/%2e/gi, ".").replace(/%2f/gi, "/").replace(/%5c/gi, "\\");
  }
  return text;
}

/**
 * Why an MCP call's arguments can't be read as harmless, or null. An argument that names a path, a URL or a host sends
 * the read somewhere the words of the request don't show (review M1). Not a list of strings: held.
 */
function argsReason(args: unknown): SafeVerdict {
  if (args === undefined) return null;
  if (!Array.isArray(args)) return "its arguments can't be read plainly, so it waits for Ash";
  for (const value of args) {
    if (typeof value !== "string") return "its arguments can't be read plainly, so it waits for Ash";
    const plain = plainName(value).trim();
    if (NAMES_PLACE.test(plain) || SCHEME.test(plain) || LOOPBACK.test(plain) || NUMERIC_HOST.test(plain) || IPV6_HOST.test(plain) || /%25/i.test(value))
      return "its arguments name a file, folder or address, so it waits for Ash";
  }
  return null;
}

/**
 * Whether a search (Grep, Glob, LS) starts outside the chat's folder, or in a credential place, so it waits (review H1).
 * Its `paths` are the places it walks from: the `path` it is given, and a Glob's pattern. A search with no path is in
 * the folder the shell works in, so it is never held here.
 */
export function searchStartsOutside(call: ApprovalCall | undefined, folder: string | undefined): boolean {
  if (!call || typeof call.tool !== "string" || !SEARCH_TOOLS.has(call.tool)) return false;
  // A glob names files by pattern, hidden ones too, and ripgrep's glob overrides its ignore rules: any glob waits (round 2).
  if (call.glob !== undefined) return true;
  // Round 5, H2: a search from a chat folder that is home or shallower (or none) holds, with or without a path.
  const base = foldedFolder(folder);
  if (!base || base.length < 3) return true;
  if (call.paths === undefined) return false;
  if (!Array.isArray(call.paths) || call.paths.some((path) => typeof path !== "string")) return true;
  // Under `find`, not `rg`: a search's paths are where it walks from, and none of them is a pattern to skip.
  return walkHeld(["find", ...call.paths], folder);
}

// ---- shell -------------------------------------------------------------------------------------------------------

/** Chaining, substitution, redirection, subshells, a newline: never allowed by itself, quoted or not. */
const SHELL_META = /[;&|`$<>()\n\r]/;

/** Why a command it can't read waits, rather than throwing. */
const UNREADABLE_COMMAND = "it can't be read plainly (a wildcard, an open quote or an expansion)";

/**
 * The words a shell call runs with: undefined when the call isn't a shell command, null when its command can't be read
 * that way. The red list is judged on these words, so a quoted path reads as the path it is (`cat ~/.ne"t"rc` names
 * the netrc). A null here is not a verdict: safeCommand refuses the same command for the same reason.
 */
export function bashWords(call: ApprovalCall | undefined): readonly string[] | null | undefined {
  if (!call || typeof call.tool !== "string" || !SHELL_TOOLS.has(call.tool)) return undefined;
  if (typeof call.command !== "string" || SHELL_META.test(call.command)) return null;
  try {
    const words = shellWords(call.command.trim());
    return words?.length ? words : null;
  } catch {
    return null;
  }
}

const has = (args: readonly string[], ...flags: string[]) =>
  args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));

/**
 * Whether the args use one of `options`, read as the program would read them: a long option matches any abbreviation
 * of it or a longer option starting with it ("--ex" and "--exec-batch" are both --exec), a one-letter short option
 * matches inside a cluster ("-Hx" is -x), and anything else matches exactly. Ported from Row-Bot's `_uses_option`.
 */
function usesOption(args: readonly string[], options: readonly string[]): boolean {
  for (const arg of args) {
    const name = arg.split("=", 1)[0].toLowerCase();
    for (const option of options) {
      if (option.startsWith("--")) {
        if (name.length > 2 && name.startsWith("--") && (option.startsWith(name) || name.startsWith(option))) return true;
      } else if (option.length === 2) {
        if (name.startsWith("-") && !name.startsWith("--") && name.slice(1).includes(option[1])) return true;
      } else if (name === option) {
        return true;
      }
    }
  }
  return false;
}

/** A command that only reads, unless it is given an option that writes a file or runs another program. */
const readsUnless = (...unsafe: string[]) => (args: readonly string[]) =>
  usesOption(args, unsafe) ? "that option writes a file or runs another program" : null;

/**
 * Read-only `find` predicates and options, matched exactly and case-sensitively. GNU find treats a unique prefix of a
 * predicate as that predicate, so a denylist of `-delete` misses `-del`. Anything starting with `-` that is not in this
 * set waits. `-d` is not `-delete`, `-executable` is not `-exec`, and `-print` is not `-fprint`. Following a symlink
 * (`-L`, `-follow`), `-xtype` and `-files0-from` are not here.
 */
const FIND_READS = new Set([
  "-a", "-and", "-o", "-or", "-not",
  "-d", "-depth", "--depth", "-maxdepth", "-mindepth", "-xdev", "-mount", "-noleaf", "-P", "-E", "-s", "-X", "-f", "--",
  "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-wholename", "-iwholename", "-lname", "-ilname",
  "-type", "-perm", "-links", "-inum", "-samefile", "-user", "-group", "-uid", "-gid", "-nouser", "-nogroup",
  "-size", "-empty", "-atime", "-mtime", "-ctime", "-amin", "-mmin", "-cmin", "-Btime", "-Bmin",
  "-newer", "-anewer", "-cnewer", "-mnewer", "-Bnewer", "-fstype",
  "-readable", "-writable", "-executable", "-true", "-false", "-prune",
  "-print", "-print0", "-printx", "-printf", "-ls", "-quit",
  "-daystart", "-ignore_readdir_race", "-noignore_readdir_race", "-regextype", "-warn", "-nowarn",
]);

/** GNU find's `-newerXY` tests, such as `-newermt`. Two letters, each one of a, B, c, m or t. A read, not a run. */
const FIND_NEWER_XY = /^-newer[aBcmt][aBcmt]$/;

function findRead(args: readonly string[]): SafeVerdict {
  for (const arg of args) {
    if (!arg.startsWith("-") || /^-[\d]/.test(arg)) continue;
    const name = arg.split("=", 1)[0];
    if (FIND_READS.has(name) || FIND_NEWER_XY.test(name)) continue;
    return "that option writes a file or runs another program";
  }
  return null;
}

const GIT_READS: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "branch"]);
/** `git branch` only lists: these options, and names only as what --list, --contains and the like look for. */
const BRANCH_LIST_FLAGS = /^(-a|--all|-r|--remotes|-v|-vv|--verbose|-l|--list|--show-current|--merged|--no-merged|--contains|--no-contains|--points-at|--sort(=.*)?|--format(=.*)?|--column|--no-column|--color(=.*)?|--no-color|--abbrev(=.*)?|--no-abbrev|-i|--ignore-case|--omit-empty)$/;
const BRANCH_QUERY = new Set(["-l", "--list", "--merged", "--no-merged", "--contains", "--no-contains", "--points-at"]);

function gitRead(args: readonly string[]): SafeVerdict {
  const [sub, ...rest] = args;
  if (!sub || !GIT_READS.has(sub)) return "only git status, diff, log, show and branch run by themselves";
  // WP-101: --textconv joins Row-Bot's list, which runs an outside diff program.
  if (has(rest, "--output", "--ext-diff", "--textconv")) return "it writes a file or runs an outside diff";
  if (sub === "branch") {
    const flags = rest.filter((arg) => arg.startsWith("-"));
    if (flags.some((flag) => !BRANCH_LIST_FLAGS.test(flag))) return "git branch only lists by itself";
    if (rest.some((arg) => !arg.startsWith("-")) && !flags.some((flag) => BRANCH_QUERY.has(flag)))
      return "git branch only lists by itself";
  }
  return null;
}

// Tests and builds are not here (review C1): npm test, npm run check|lint|build, cargo test|check|clippy and node --test
// each run code from the package or the crate, which an allowed edit in the same chat may have just changed. Only
// cargo fmt --check remains: it reads the code and runs none of it.
function cargoRead(args: readonly string[]): SafeVerdict {
  const [sub, ...rest] = args;
  if (sub !== "fmt") return "only cargo fmt --check runs by itself; cargo test, check, clippy and build run code, so they wait for Ash";
  if (!rest.includes("--check")) return "cargo fmt rewrites files unless it is --check";
  if (has(rest, "--config", "--manifest-path", "--target-dir", "--artifact-dir", "--out-dir", "--emit") || rest.some((arg) => arg.startsWith("-Z")))
    return "that cargo option doesn't run by itself";
  return null;
}

/**
 * The only ps fields autopilot may ask for: one process's own numbers. None prints its environment or its command
 * line: macOS prints both from `comm` on some systems (the full command with its arguments, confirmed against a child
 * started with a secret in argv), so it is not here either.
 */
const PS_FIELDS = new Set(["pid", "ppid", "etime", "state", "stat", "%cpu", "%mem", "rss"]);

/**
 * `ps` only for one process's own status, as `ps -p <pid> -o <fields>` with `-o` required, fields from the fixed list
 * above. A bare `ps -p <pid>` prints the full command line with its arguments on macOS, which can carry a secret, so it
 * waits. Every other shape prints every process's environment (`ps e`, `ps eww`, `-E`, `e` in a cluster) or every
 * process's command line (`ps aux`, `ps -ef`, `-o command`). Windows has no `ps`, so this holds it everywhere.
 */
function psRead(args: readonly string[]): SafeVerdict {
  if (args.length === 4 && args[0] === "-p" && /^\d+$/.test(args[1]) && args[2] === "-o") {
    const fields = args[3].split(",");
    if (fields.every((field) => PS_FIELDS.has(field))) return null;
  }
  return "ps only runs by itself for one process, as ps -p <pid> -o <fields>, with the fields from pid, ppid, etime, state, stat, %cpu, %mem and rss";
}

/**
 * Whether `given` abbreviates `option` one dash-separated piece at a time. `--pr` is `--pre` by the ordinary prefix
 * rule; `--pr-glob` is not, because neither string starts with the other, but each piece of it is a prefix of the same
 * piece of `--pre-glob`. A longer word such as `--pretty` abbreviates the same way and waits too.
 */
function abbreviatesLongOption(given: string, option: string): boolean {
  const name = given.split("=", 1)[0].toLowerCase();
  if (!name.startsWith("--") || !option.startsWith("--")) return false;
  const left = name.slice(2).split("-");
  const right = option.slice(2).split("-");
  if (left.length !== right.length || left.some((part) => !part)) return false;
  return left.every((part, i) => right[i].startsWith(part) || part.startsWith(right[i]));
}

/**
 * Short options that follow links, written as the program reads them. usesOption lower-cases a name, so an upper-case
 * letter (-L) is matched against the raw argument here (review M4).
 */
const followsLinks = (args: readonly string[]) => args.some((arg) => /^-[^-]*L/.test(arg) || arg === "--follow" || arg.startsWith("--follow="));

function rgRead(args: readonly string[]): SafeVerdict {
  // --pre runs a program on every file; --hostname-bin runs one too. A short form of either does as well. -L and
  // --follow read through links, which can lead out of the folder into a login store (review M4).
  const options = ["--pre", "--pre-glob", "--hostname-bin"];
  if (usesOption(args, options) || args.some((arg) => options.some((option) => abbreviatesLongOption(arg, option))))
    return "rg --pre runs a program";
  if (followsLinks(args)) return "that option follows links out of the folder";
  return null;
}

const COMMANDS: Readonly<Record<string, (args: readonly string[]) => SafeVerdict>> = {
  git: gitRead,
  cargo: cargoRead,
  rg: rgRead,
  grep: () => null,
  ls: () => null,
  cat: () => null,
  head: () => null,
  tail: () => null,
  wc: () => null,
  pwd: () => null,
  // WP-101, from Row-Bot's safe-command table: listing and system information that only read, with the options
  // that turn each into a write or a run held.
  find: findRead,
  // fd: --base-directory and --search-path move the walk to another folder, and -L/--follow read through links (M4).
  fd: (args) => readsUnless("-x", "--exec", "--exec-batch", "--base-directory", "--search-path")(args) ?? (followsLinks(args) ? "that option follows links out of the folder" : null),
  ag: readsUnless("--pager", "-f", "--follow"),
  // tree writes to a file with -o, and with -R and -H it writes an HTML file into every folder; -l follows links.
  // --output is held too though tree has no such option, since a stricter answer costs Ash one tap and a looser one
  // cannot be taken back.
  tree: (args) =>
    readsUnless("-o", "--output")(args) ?? (args.some((arg) => /^-[^-]*[RHl]/.test(arg)) ? "that option writes files or follows links" : null),
  stat: () => null,
  // du -L reads through links (review M4).
  du: (args) => (followsLinks(args) ? "that option follows links out of the folder" : null),
  df: () => null,
  file: readsUnless("-c", "--compile"),
  which: () => null,
  ps: psRead,
};

/** Whether one word of a command names a protected config, or a path through a dot-named folder, as an option or bare. */
function namesProtectedConfig(arg: string, folder: string | undefined): boolean {
  const root = folder?.replace(/\/+$/, "") ?? "";
  const values = arg.startsWith("-")
    ? [arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "", arg.includes("/") ? arg.slice(arg.indexOf("/")) : ""]
    : [arg];
  return values.some((value) => {
    // Inside the chat's own folder, the folder's own names are not the config: only the part below it is judged.
    const inside = root && value.startsWith(`${root}/`) ? value.slice(root.length) : value;
    return inside !== "" && isProtectedConfig(segmentsOf(inside).filter(Boolean), false);
  });
}

function safeCommandInner(command: string, folder: string | undefined, timer = false): SafeVerdict {
  if (typeof command !== "string") return UNREADABLE_COMMAND;
  if (SHELL_META.test(command)) return "it chains, substitutes or redirects";
  const words = shellWords(command.trim());
  if (!words?.length) return UNREADABLE_COMMAND;
  // Own keys only: "valueOf" or "constructor" must not find Object's methods where the table should be (WP-101, row 21).
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, words[0])) return `${words[0]} isn't a read autopilot runs by itself`;
  const check = COMMANDS[words[0]];
  if (typeof check !== "function") return UNREADABLE_COMMAND;
  // WP-101 fix round 2, item B: a walk through folders has to start inside the chat's own, whatever it names.
  if (walkHeld(words, folder, timer)) return "it walks folders outside the chat's own, or reads what a project keeps out of git, so it waits for Ash";
  // A config the tools read, or a dot-named folder or file, is held as an edit is (review round 3, item 1).
  if (words.slice(1).some((arg) => namesProtectedConfig(arg, folder))) return "it names a tool's config or a dot-named file, so it waits for Ash";
  return check(words.slice(1));
}

/** Whether a shell command is one autopilot may run by itself; why not otherwise. A command it can't read waits. */
export function safeCommand(command: string, folder?: string | undefined, timer = false): SafeVerdict {
  try {
    return safeCommandInner(command, folder, timer);
  } catch {
    return UNREADABLE_COMMAND;
  }
}

/**
 * Whether a tool call is one autopilot may allow by itself in a chat working in `folder`; why not otherwise.
 * `trusted` is the exact set of MCP servers Hivra wired from installed plugins for this chat (mcpTrust.ts). A name
 * alone never counts, and a missing set trusts nothing.
 */
export function safeCall(call: ApprovalCall | undefined, folder: string | undefined, trusted?: TrustedServers | null): SafeVerdict {
  try {
    return safeCallInner(call, folder, trusted);
  } catch {
    return "it can't be read plainly, so it waits for Ash";
  }
}

function safeCallInner(call: ApprovalCall | undefined, folder: string | undefined, trusted?: TrustedServers | null): SafeVerdict {
  if (!call) return "it doesn't say exactly what it runs";
  if (typeof call.tool !== "string" || !call.tool) return "it doesn't say exactly what it runs";
  // A resource read or list goes to one named server, so only a server Hivra wired is trusted (review M3).
  if (MCP_RESOURCE_TOOLS.has(call.tool)) {
    if (!serverTrusted(trusted, call.server)) return `${call.tool} reads from a server Hivra didn't install, so it waits for Ash`;
    return argsReason(call.args);
  }
  if (READ_ONLY_TOOLS.has(call.tool)) return null;
  if (EDIT_TOOLS.has(call.tool)) {
    if (!call.paths?.length) return "it doesn't say which file it edits";
    for (const path of call.paths) {
      const why = editInside(path, folder);
      if (why) return why;
    }
    return null;
  }
  if (SHELL_TOOLS.has(call.tool)) return call.command === undefined ? "it doesn't say what it runs" : safeCommand(call.command, folder);
  const mcp = splitMcpTool(call.tool);
  if (mcp) {
    // A hostile server can name a write tool `get_x` and can call itself `plugin-anything`, so a name alone counts
    // for nothing: only a server in the set Hivra itself wired from an installed plugin does. Every other server's
    // tools wait, however they read, and so does every one of them when the set couldn't be read.
    // WP-101 fix round 2, item D: the server part is compared the way Claude Code makes the tool id, so a name a
    // project's .mcp.json spells differently but Claude Code reads the same is that config's server, not Hivra's.
    if (!serverTrusted(trusted, mcp.server)) return `${call.tool} comes from a server Hivra didn't install, so it waits for Ash`;
    const effect = toolEffect(mcp.tool);
    if (effect !== "read_only") return `it is an MCP ${effect === "change" ? "change" : effect === "high_impact" ? "high-impact action" : "call autopilot can't place"}, so it waits for Ash`;
    // Even a read names what it reads by its arguments: a path, a URL or a host in one of them waits (review M1).
    return argsReason(call.args);
  }
  return `${call.tool} isn't a read or an edit in the chat's folder`;
}

/**
 * Whether a shell command's words name a login store, or a search over hidden files (a glob in a search), read the way
 * an approval's words are (round 2: agent timers run the same check). Null when they don't; never an allow by itself.
 */
export function commandNamesLogin(command: string): SafeVerdict {
  const words = bashWords({ tool: "Bash", command });
  if (!words) return UNREADABLE_COMMAND;
  // A timer has no chat folder, so a rooted word, a climb or a dot-named part is outside it: the rule the Rust timer check
  // holds (watcher/safe_cmd.rs names_login_or_outside; round 4, item 4).
  if (timerOutside(words)) return "it names a folder outside the chat's own, so it waits for Ash";
  return credentialInWords(words) ? "it names a login store or searches files the ignore rules hide, so it waits for Ash" : null;
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

// ---- where a read or a search really lands --------------------------------------------------------------------------

/**
 * Whether a read or a search of paths inside the chat's folder stays on a file the credential rules allow, once links
 * are followed (round 5, M2). Edits resolve through the app's lookup (editStaysInside); reads and searches do too, so a
 * link that leads to a login or config file is held. A path the app can't place (outside git, or the lookup failed) waits.
 * A search with no path walks the folder itself, which its ignore rules bound, so it is not looked up here.
 */
export async function readStaysInside(call: ApprovalCall | undefined, folder: string | undefined, locate: Locate): Promise<SafeVerdict> {
  if (!call || !(READ_ONLY_TOOLS.has(call.tool) || SEARCH_TOOLS.has(call.tool))) return null;
  if (!Array.isArray(call.paths) || !call.paths.length) return null;
  // A path that isn't text is held by safeCall and searchStartsOutside already.
  if (call.paths.some((path) => typeof path !== "string")) return null;
  const paths = call.paths as string[];
  const root = folder?.replace(/\/+$/, "");
  if (!root) return "the chat has no folder of its own to read in";
  const targets = paths.map((path) => (path.startsWith("/") ? path : `${root}/${path}`));
  let places: (RealPlace | null)[];
  try {
    places = await locate([`${root}/${PROBE}`, ...targets]);
  } catch (error) {
    return `the app couldn't find where it really reads (${error instanceof Error ? error.message : String(error)})`;
  }
  const home = places[0];
  if (!home || !home.relative.endsWith(PROBE)) return "the app couldn't place the chat's folder in a git checkout";
  const realFolder = realPath(home, home.relative.slice(0, -PROBE.length).replace(/\/+$/, ""));
  for (let i = 0; i < targets.length; i++) {
    const place = places[i + 1];
    if (!place) return `the app couldn't place ${paths[i]} in a git checkout, so it can't tell where it really reads`;
    const real = realPath(place);
    if (credentialPath(real) || dotOutside(real, realFolder)) return `${paths[i]} really reads ${real}, a login or config file`;
  }
  return null;
}

/** The lookup check for whatever a tool call touches: an edit's real place, or a read's or search's (round 5, M2). */
export function placeStaysInside(call: ApprovalCall | undefined, folder: string | undefined, locate: Locate): Promise<SafeVerdict> {
  if (call && EDIT_TOOLS.has(call.tool)) return editStaysInside(call, folder, locate);
  return readStaysInside(call, folder, locate);
}
