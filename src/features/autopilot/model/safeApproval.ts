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
import { credentialInWords, credentialPath, dotOutside, foldedFolder, projectFolder, timerOutside, walkHeld, wordOutside } from "./credentialPaths";
import { foldSegment, guardRunHeld, isProtectedConfig, segmentsOf } from "./protectedConfig";
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

/** A git folder's own files (round 7, HIGH-A): a file of one of these names makes its folder a repository to git. */
const GIT_DIR_FILES: ReadonlySet<string> = new Set(["head", "config", "packed-refs", "commondir", "gitdir"]);
/** A git folder's object and ref stores (round 7, HIGH-A): held under any folder in a chat's own. */
const GIT_DIR_FOLDERS: ReadonlySet<string> = new Set(["objects", "refs"]);

/**
 * The values an option word carries: the text after `=`, and every suffix of a short-option cluster from its third letter
 * (round 8, MED-B: `-bfnotes` carries `fnotes` and `notes`, and `file` reads `notes` after the `f`).
 */
function optionValues(word: string): string[] {
  const out: string[] = [];
  if (word.startsWith("-") && word.includes("=")) out.push(word.slice(word.indexOf("=") + 1));
  if (/^-[^-]/.test(word)) for (let i = 2; i < word.length; i++) out.push(word.slice(i));
  return out.filter(Boolean);
}

/**
 * Round 9 (LOW): the short-option clusters a read command takes as flags only, so `ls -la`, `git log -n5` and `head -n5` are
 * not read as naming a file. A cluster of these is no value; anything else that carries one counts as an operand.
 */
const FLAG_CLUSTERS: Readonly<Record<string, RegExp>> = {
  ls: /^-[A-Za-z]+$/,
  cat: /^-[A-Za-z]+$/,
  wc: /^-[A-Za-z]+$/,
  stat: /^-[A-Za-z]+$/,
  du: /^-[A-Za-z]+$/,
  head: /^-[A-Za-z]*\d*$/,
  tail: /^-[A-Za-z]*\d*$/,
  git: /^-[A-NP-Za-z]+\d*$/,
};

/** Whether an option word carries a value (optionValues) that the command doesn't read as a flag cluster (round 9). */
function carriesValue(head: string, word: string): boolean {
  if (!optionValues(word).length) return false;
  const flags = Object.prototype.hasOwnProperty.call(FLAG_CLUSTERS, head) ? FLAG_CLUSTERS[head] : undefined;
  return !(flags && flags.test(word));
}

/** A drive path, C:\ or C:/ (round 7, Windows CI). */
const DRIVE = /^[a-z]:[\\/]/i;

/** Whether a path is absolute: rooted at / or at a drive (round 7, Windows CI). */
const isAbsolutePath = (path: string) => path.startsWith("/") || DRIVE.test(path);

/**
 * An absolute path with ".", ".." and repeated slashes resolved; null when it isn't one or climbs past its root. A drive
 * path (round 7, Windows CI) keeps its drive as the first part.
 */
function normalize(path: string, windows = false): string[] | null {
  // Round 8: a backslash is a separator only on Windows (a drive or UNC path). On a Mac or Linux it is a letter of a name.
  const text = windows ? path.replace(/\\/g, "/") : path;
  const drive = windows && DRIVE.test(text);
  if (!drive && !text.startsWith("/")) return null;
  const floor = drive ? 1 : 0;
  const out: string[] = drive ? [text.slice(0, 2).toLowerCase()] : [];
  for (const part of (drive ? text.slice(2) : text).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length <= floor) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/**
 * Whether a folder's file system ignores case: Windows (a drive or a UNC share) and the Mac's own folders (/Users, /Volumes,
 * /private). Elsewhere names are compared as written (round 7, Windows CI).
 */
export function ignoresCase(folder: string): boolean {
  return DRIVE.test(folder) || /^\\\\|^\/\//.test(folder) || /^\/(users|volumes|private)\//i.test(folder);
}

/**
 * A path as a containment check compares it (round 7, Windows CI): forward slashes, a verbatim `\\?\` prefix gone, repeated
 * and trailing slashes gone, and case folded where the file system ignores case.
 */
export function comparablePath(path: string, caseless: boolean, windows = false): string {
  // Round 8: a backslash becomes a separator only for a Windows path; on a Mac it is part of a name and stays one.
  const stripped = path.replace(/^(\\\\\?\\|\/\/\?\/)/, "");
  const text = (windows ? stripped.replace(/\\/g, "/") : stripped)
    .replace(/\/+/g, "/")
    .replace(/(.)\/$/, "$1");
  return caseless ? text.toLowerCase() : text;
}

/** Whether a path is a Windows path: a drive (C:\ or C:/) or a UNC share (\\server). Round 8: only these read \ as a separator. */
export function windowsShaped(path: string): boolean {
  return DRIVE.test(path) || /^\\\\/.test(path);
}

/**
 * Whether `real` is `folder` or inside it, compared by whole path components, never by a string prefix (so `chat2` is not
 * inside `chat`). Both sides are read the same way, whatever their separators. `windows` says which reading of a backslash
 * applies; by default a Windows path (a drive or a UNC share) on either side reads it as a separator, and nothing else does.
 */
export function pathWithin(
  real: string,
  folder: string,
  caseless = ignoresCase(folder),
  windows = windowsShaped(folder),
): boolean {
  const r = lexicalParts(comparablePath(real, caseless, windows));
  const f = lexicalParts(comparablePath(folder, caseless, windows));
  return !!r && !!f && r.length >= f.length && f.every((part, i) => r[i] === part);
}

/**
 * The parts of a comparable path with `.` and `..` taken by words (round 8): a `..` after a name goes up one name. A climb
 * past the root is null, so the path is never inside anything. A root (`/` or a drive) is the first part and can't be climbed.
 */
function lexicalParts(text: string): string[] | null {
  const parts = text.split("/");
  const rooted = parts[0] === "" || /^[a-z]:$/i.test(parts[0]);
  const out: string[] = rooted ? [parts[0]] : [];
  for (const part of rooted ? parts.slice(1) : parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length <= (rooted ? 1 : 0)) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/** Whether an edit to `path` may go ahead in `folder`; why not otherwise. */
/**
 * The path a file tool opens, and why a path can't be checked as it is (round 9). Claude Code opens Write, Edit, Read and
 * Grep paths as p4 does: the string trimmed, then normalized (absolute) or resolved against the folder (relative), so `..`
 * is taken by words and only then does the kernel follow links. So the path checked must already be in that form: no
 * space or line break around it, the normal Unicode form, no `.` or `..` segment, no doubled or trailing separator, and no
 * backslash on a Mac or Linux. A relative path is checked as the absolute path it opens. The platform comes from the chat's
 * folder only (round 9): a path can't switch the reading.
 */
export function openedForm(raw: string, folder: string | undefined): { path: string } | { why: string } {
  if (typeof raw !== "string" || raw === "") return { why: "it names no file" };
  if (raw.includes("\0")) return { why: "its path has a NUL in it" };
  if (raw !== raw.trim()) return { why: "its path has a space, tab or line break around it, which the tool trims before it opens the file, so it waits for Ash" };
  if (raw !== raw.normalize("NFC")) return { why: "its name isn't in the normal Unicode form, so it waits for Ash" };
  const windows = !!folder && windowsShaped(folder);
  // Round 11 (HIGH, Windows): an NTFS stream or a second ":" names a stream of the file (name::$DATA, name:x), not the
  // file a protected name is checked against, so a colon after the drive letter waits.
  if (windows && raw.slice(2).includes(":")) return { why: `it names ${raw}, which has a colon after the drive (an NTFS stream), so it waits for Ash` };
  if (!windows && raw.includes("\\")) return { why: `it names ${raw}, which has a backslash in it (a folder separator only on Windows), so it waits for Ash` };
  if (windows && raw.includes("/")) return { why: `it names ${raw} with forward slashes, which the tool doesn't open as written, so it waits for Ash` };
  // A UNC share (\\server) is not absolute here: it is held, as a relative name that doesn't rebuild as written.
  const absolute = windows ? DRIVE.test(raw) : raw.startsWith("/");
  // Round 10: a relative path waits for every file tool. The tool resolves it against its own working folder, which a Bash
  // `cd` can move, so the chat's folder is not the place it opens.
  if (!absolute) return { why: `it names ${raw}, a relative path, which the tool resolves against its own working folder (a cd can move it), so it waits for Ash` };
  if (!spelledAsOpened(raw, windows, true)) return { why: `it names ${raw}, which isn't in the form the tool opens (no . or .. and no doubled or trailing separator), so it waits for Ash` };
  return { path: raw };
}

/** Whether a path is absolute on the chat's platform (round 10). */
function absoluteOn(raw: string, windows: boolean): boolean {
  return windows ? DRIVE.test(raw) : raw.startsWith("/");
}

/**
 * The path a search (Grep, Glob, LS) walks from (round 10, round 11). An absolute path is opened as openedForm opens it. A
 * relative path, or none, is resolved against the chat folder only when the provider pinned the folder (`pinned`, set by
 * the Claude launch: CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR keeps the tool in the launch folder, which is the chat folder).
 * Any other provider's relative or missing path waits. The pin comes from the provider, never from the tool input.
 */
export function openedSearchPath(raw: string | undefined, folder: string | undefined, pinned: boolean): { path: string } | { why: string } {
  if (!folder) return { why: "the chat has no folder to search in" };
  const windows = windowsShaped(folder);
  if (raw !== undefined && typeof raw === "string" && absoluteOn(raw, windows)) return openedForm(raw, folder);
  if (!pinned) return { why: "its search starts from a relative or missing path, and this provider does not keep its folder to the chat's, so it waits for Ash" };
  const base = folder.replace(/[\\/]+$/, "");
  if (raw === undefined) return { path: base };
  if (typeof raw !== "string" || raw === "" || raw !== raw.trim() || raw !== raw.normalize("NFC") || !spelledAsOpened(raw, windows, false))
    return { why: `it names ${String(raw)}, which isn't in the form the tool opens (no . or .. and no doubled or trailing separator), so it waits for Ash` };
  if (!windows && raw.includes("\\")) return { why: `it names ${raw}, which has a backslash in it, so it waits for Ash` };
  return { path: `${base}${windows ? "\\" : "/"}${raw}` };
}

/**
 * Whether a path is already spelled as its own normalized form: rebuilding it from its parts, without `.`, `..`, empty or
 * trailing parts, gives the same string. `absolute` says whether it is rooted (a `/`, or a drive on Windows).
 */
function spelledAsOpened(raw: string, windows: boolean, absolute: boolean): boolean {
  const sep = windows ? "\\" : "/";
  const cut = windows ? /[\\]/ : /\//;
  let root = "";
  let body = raw;
  if (absolute) {
    root = windows ? raw.slice(0, 3) : "/";
    body = raw.slice(root.length);
  }
  const out: string[] = [];
  for (const part of body.split(cut)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return false;
      out.pop();
      continue;
    }
    out.push(part);
  }
  const rebuilt = root + out.join(sep);
  return rebuilt === raw;
}

/** Whether a word's suffix (from any position) has a `..` segment, so a climb the shell follows through a link (round 9). */
function hasClimb(word: string): boolean {
  for (let i = 0; i <= word.length; i++) {
    if (word.slice(i).split("/").includes("..")) return true;
  }
  return false;
}

export function editInside(raw: string, folder: string | undefined): SafeVerdict {
  // Round 9: the path checked is the one the tool opens (openedForm), so a word that climbs or carries whitespace waits.
  const form = openedForm(raw, folder);
  if ("why" in form) return `it edits ${raw}: ${form.why}`;
  const path = form.path;
  const windows = windowsShaped(folder ?? "");
  const root = folder ? normalize(folder.replace(/\/+$/, "") || "/", windows) : null;
  if (!root) return "the chat has no folder of its own to edit in";
  if (root.length < MIN_FOLDER_DEPTH) return "the chat's folder is too broad to edit in by itself";
  const parts = normalize(path, windows);
  if (!parts || parts.length <= root.length || root.some((part, i) => parts[i] !== part))
    return `it edits ${path}, outside the chat's folder`;
  const inner = parts.slice(root.length);
  if (isProtectedConfig(inner)) return `it edits ${path}, which changes how tools run`;
  // Round 7, HIGH-A (a): a folder with a HEAD and the other git files of a repository is a repository to git, whose config
  // runs programs (core.fsmonitor, diff.external) on every status and diff. So a write of one of those files, and a write
  // under an objects/ or refs/ folder, waits. The objects/ and refs/ folders are held wherever they are, not only beside a
  // HEAD: a HEAD can be written by a later edit, and the planted folders must not be there first.
  if (GIT_DIR_FILES.has(foldSegment(inner[inner.length - 1]))) return `it edits ${path}, a git folder's own file, which changes how git runs`;
  if (inner.slice(0, -1).some((part) => GIT_DIR_FOLDERS.has(foldSegment(part))))
    return `it edits ${path}, under a git folder's objects or refs, which changes how git runs`;
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
  // Round 10: a search with no path starts from its request's cwd; with neither, it waits (openedSearchPath).
  if (call.paths !== undefined && (!Array.isArray(call.paths) || call.paths.some((path) => typeof path !== "string"))) return true;
  // Under `find`, not `rg`: a search's paths are where it walks from, and none of them is a pattern to skip.
  // Round 9: the walk starts from the path the tool opens (openedForm); inside the folder it is judged as a relative place.
  const raws: (string | undefined)[] = call.paths === undefined ? [undefined] : (call.paths as string[]);
  const forms = raws.map((raw) => openedSearchPath(raw, folder, call.folderPinned === true));
  if (forms.some((form) => "why" in form)) return true;
  // Round 12: an absolute start outside the chat folder waits, read the Windows way (a drive path is absolute).
  // walkHeld used to see only a leading "/", so `C:\Users\dev` from a chat in `C:\Users\dev\Projects\app` was allowed.
  const windows = !!folder && windowsShaped(folder);
  if (
    !!folder &&
    forms.some((form) => {
      const opened = (form as { path: string }).path;
      return absoluteOn(opened, windows) && !pathWithin(opened, folder);
    })
  )
    return true;
  const home = (folder ?? "").replace(/[\\/]+$/, "");
  const starts = forms.map((form) => {
    const opened = (form as { path: string }).path;
    const under = home;
    return opened.startsWith(`${under}/`) || opened.startsWith(`${under}\\`) ? opened.slice(under.length + 1) : opened;
  });
  return walkHeld(["find", ...starts], folder);
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

/** `-z` and `--search-zip` read the inside of compressed files, which the ignore rules and the place rules do not see (round 6). */
const searchesZip = (args: readonly string[]) => args.some((arg) => /^-[^-]*z/.test(arg) || arg === "--search-zip" || arg.startsWith("--search-zip="));

function rgRead(args: readonly string[]): SafeVerdict {
  // --pre runs a program on every file; --hostname-bin runs one too. A short form of either does as well. -L and
  // --follow read through links, which can lead out of the folder into a login store (review M4).
  const options = ["--pre", "--pre-glob", "--hostname-bin"];
  if (usesOption(args, options) || args.some((arg) => options.some((option) => abbreviatesLongOption(arg, option))))
    return "rg --pre runs a program";
  if (followsLinks(args)) return "that option follows links out of the folder";
  if (searchesZip(args)) return "that option reads compressed files, which the login rules can't see into";
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
  // -z and --search-zip read inside compressed files, which the login rules can't see into (round 7, LOW; rg has held them since round 6).
  ag: readsUnless("--pager", "-f", "--follow", "-z", "--search-zip"),
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

function safeCommandInner(command: string, folder: string | undefined, timer = false, pinned = false): SafeVerdict {
  if (typeof command !== "string") return UNREADABLE_COMMAND;
  if (SHELL_META.test(command)) return "it chains, substitutes or redirects";
  const words = shellWords(command.trim());
  if (!words?.length) return UNREADABLE_COMMAND;
  // Own keys only: "valueOf" or "constructor" must not find Object's methods where the table should be (WP-101, row 21).
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, words[0])) return `${words[0]} isn't a read autopilot runs by itself`;
  const check = COMMANDS[words[0]];
  if (typeof check !== "function") return UNREADABLE_COMMAND;
  // Round 11 (MED): a provider that doesn't keep its shell in the chat folder can't have a relative operand judged here: the
  // shell runs in whatever folder a cd left it in. A timer runs in its own folder, so it is judged as before.
  const operandStart = words[0] === "git" || words[0] === "cargo" ? 2 : 1;
  const relativeOperand = words.slice(operandStart).some((word) => {
    if (!word.startsWith("-")) return !word.startsWith("/") && !word.startsWith("~");
    return carriesValue(words[0], word) && optionValues(word).some((value) => !value.startsWith("/"));
  });
  if (!timer && !pinned && relativeOperand) return "it names a relative path, and this provider's shell may be in a folder a cd moved, so it waits for Ash";
  // Round 9 (MED): a word with a `..` segment after a name waits, since the kernel follows a link before the climb. A
  // Mac or Linux shell word with a literal backslash waits too: fold reads a backslash as a separator, the shell doesn't.
  if (words.slice(1).some(hasClimb)) return "a word climbs with .. after a name, which the shell follows through a link, so it waits for Ash";
  if (!windowsShaped(folder ?? "") && words.some((word) => word.includes("\\"))) return "a word has a backslash in it, which the shell reads as a letter of a name, so it waits for Ash";
  // WP-101 fix round 2, item B: a walk through folders has to start inside the chat's own, whatever it names.
  if (walkHeld(words, folder, timer)) return "it walks folders outside the chat's own, or reads what a project keeps out of git, so it waits for Ash";
  // Round 7, LOW: a timer in a folder that can't hold a walk (home, a parent of a project, or none) takes no bare name, so
  // `grep -c X Documents/f` can't read a file of the person's own. Flags stay as they were.
  // A git or cargo subcommand (`status`, `fmt`) is no file name, so it is not counted.
  const operands = words[0] === "git" || words[0] === "cargo" ? words.slice(2) : words.slice(1);
  // Round 8 (LOW): an option's glued or `=` value is an operand too (`file -fnotes.txt`, `wc --files0-from=notes.txt`).
  if (timer && !projectFolder(folder) && operands.some((word) => !word.startsWith("-") || carriesValue(words[0], word)))
    return "a timer in a folder this shallow can't read a file by name, so it waits for Ash";
  // Round 6, HIGH-1: a word that names a place outside the chat's own folder (a rooted path, a home word, a climb out) waits,
  // whatever the command, so a read of the hub's database copies or a browser's store by its absolute path does not pass.
  if (words.slice(1).some((arg) => wordOutside(arg, folder))) return "it names a file outside the chat's own folder, so it waits for Ash";
  // A config the tools read, or a dot-named folder or file, is held as an edit is (review round 3, item 1).
  if (words.slice(1).some((arg) => namesProtectedConfig(arg, folder))) return "it names a tool's config or a dot-named file, so it waits for Ash";
  return check(words.slice(1));
}

/** Whether a shell command is one autopilot may run by itself; why not otherwise. A command it can't read waits. */
// Direct callers (timers, the chat's own questions) judge a relative operand in the folder they run in; an approval passes its provider's pin.
export function safeCommand(command: string, folder?: string | undefined, timer = false, pinned = true): SafeVerdict {
  try {
    return safeCommandInner(command, folder, timer, pinned);
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
  // Round 9: a read or search names a path the tool opens as written (openedForm), or it waits.
  if (READ_ONLY_TOOLS.has(call.tool)) {
    if (!Array.isArray(call.paths)) return null;
    // A search's start is judged by searchStartsOutside, through openedSearchPath (round 10).
    if (SEARCH_TOOLS.has(call.tool)) return null;
    for (const path of call.paths) {
      if (typeof path !== "string") return "a path it reads isn't text, so it waits for Ash";
      const form = openedForm(path, folder);
      if ("why" in form) return form.why;
    }
    return null;
  }
  if (EDIT_TOOLS.has(call.tool)) {
    if (!call.paths?.length) return "it doesn't say which file it edits";
    for (const path of call.paths) {
      const why = editInside(path, folder);
      if (why) return why;
    }
    return null;
  }
  if (SHELL_TOOLS.has(call.tool)) return call.command === undefined ? "it doesn't say what it runs" : safeCommand(call.command, folder, false, call.folderPinned === true);
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
export type RealPlace = {
  root: string;
  relative: string;
  /** Whether the path's last part is a link (round 6, MED-1): a read of one must land inside the chat's folder. */
  linked?: boolean;
  /** Whether the checkout's root holds a `.git` folder or file (round 7). Git commands in a folder without one wait. */
  dotGit?: boolean;
};
/** The app's lookup of real places; null for a path outside git. */
export type Locate = (paths: string[]) => Promise<(RealPlace | null)[]>;
/**
 * The app's canonical path of each path, every link followed and a file that doesn't exist yet placed by its parent; null
 * when it can't be placed. Used only for a chat outside git (round 7), where the lookup above has nothing to say.
 */
export type Canonical = (paths: string[]) => Promise<(string | null)[]>;

/** A name looked up inside the chat's folder, so the lookup resolves the folder itself (it needn't exist). */
const PROBE = ".monocode-autopilot-probe";

/** Whether a real path is inside a folder (a checkout's root), by whole segments. */
const insideFolder = (real: string, folder: string) => real.startsWith(`${folder.replace(/\/+$/, "")}/`);

const realPath = (place: RealPlace, relative = place.relative) =>
  relative ? `${place.root.replace(/\/+$/, "")}/${relative}` : place.root;

/** Whether a real path is the folder itself or inside it. */
const within = (real: string, folder: string) => real === folder.replace(/\/+$/, "") || insideFolder(real, folder);

/**
 * Whether a target's own words lie inside the folder, before any link is followed (round 7, MED-C). A read whose words
 * are outside the folder keeps its rule (MED-D); a read whose words are inside and whose real place is not, waits.
 */
function namedInside(target: string, root: string): boolean {
  const named = normalize(target, windowsShaped(root));
  const base = normalize(root, windowsShaped(root));
  return !!named && !!base && named.length > base.length && base.every((part, i) => named[i] === part);
}

/**
 * A chat outside git (round 7, usability): each path is placed by its canonical path, every link followed. It waits unless
 * it really lands inside the chat's own folder and `check` (when given) passes its real place. Only a chat the git lookup
 * can't place uses this, so such a chat no longer waits on every command.
 */
async function outsideGitStays(
  names: string[],
  targets: string[],
  folder: string,
  canonical: Canonical | undefined,
  check?: (real: string, realFolder: string, index: number) => SafeVerdict,
): Promise<SafeVerdict> {
  if (!canonical) return "the app couldn't place the chat's folder in a git checkout";
  let resolved: (string | null)[];
  try {
    resolved = await canonical([folder, ...targets]);
  } catch (error) {
    return `the app couldn't resolve where it really lands (${error instanceof Error ? error.message : String(error)})`;
  }
  const realFolder = resolved[0];
  if (!realFolder) return "the app couldn't resolve the chat's folder";
  for (let i = 0; i < targets.length; i++) {
    const real = resolved[i + 1];
    if (!real) return `${names[i]} can't be resolved, so it waits for Ash`;
    if (!pathWithin(real, realFolder)) return `${names[i]} really lands at ${real}, outside the chat's folder`;
    const why = check?.(real, realFolder, i);
    if (why) return why;
  }
  return null;
}

/**
 * Whether an edit the words allowed still lands inside the chat's folder once links are followed; why not otherwise.
 * Not an edit: nothing to check. A folder or file the app can't place (outside git, or the lookup failed) waits: a
 * file name that is itself a link isn't resolved by the lookup, which is why node_modules is held by name too.
 */
export async function editStaysInside(
  call: ApprovalCall | undefined,
  folder: string | undefined,
  locate: Locate,
  canonical?: Canonical,
): Promise<SafeVerdict> {
  if (!call || !EDIT_TOOLS.has(call.tool)) return null;
  const root = folder?.replace(/\/+$/, "");
  if (!root || !call.paths?.length) return "it doesn't say which file it edits";
  // Round 9: each target is the path the tool opens (openedForm); a form it can't open waits.
  const forms = call.paths.map((path) => openedForm(path, root));
  const refused = forms.find((form): form is { why: string } => "why" in form);
  if (refused) return refused.why;
  const targets = forms.map((form) => (form as { path: string }).path);
  let places: (RealPlace | null)[];
  try {
    places = await locate([`${root}/${PROBE}`, ...targets]);
  } catch (error) {
    return `the app couldn't find where it really edits (${error instanceof Error ? error.message : String(error)})`;
  }
  const home = places[0];
  // Round 7, usability: a chat outside git is judged by where each edit really lands, every link followed.
  if (!home) return outsideGitStays(call.paths, targets, root, canonical, (real, realFolder) => editInside(real, realFolder));
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
export async function readStaysInside(
  call: ApprovalCall | undefined,
  folder: string | undefined,
  locate: Locate,
  canonical?: Canonical,
): Promise<SafeVerdict> {
  if (!call || !(READ_ONLY_TOOLS.has(call.tool) || SEARCH_TOOLS.has(call.tool))) return null;
  const search = SEARCH_TOOLS.has(call.tool);
  if (!search && (!Array.isArray(call.paths) || !call.paths.length)) return null;
  // A path that isn't text is held by safeCall and searchStartsOutside already.
  if (Array.isArray(call.paths) && call.paths.some((path) => typeof path !== "string")) return null;
  const raws: (string | undefined)[] = call.paths === undefined ? [undefined] : (call.paths as string[]);
  const paths = raws.map((raw) => String(raw ?? "the search's folder"));
  const root = folder?.replace(/\/+$/, "");
  if (!root) return "the chat has no folder of its own to read in";
  // Round 9: each target is the path the tool opens (openedForm); a form it can't open waits. Round 10: a search's start is
  // the path it opens (openedSearchPath), resolved against the request's cwd when it is relative or missing.
  const forms = raws.map((raw) => (search ? openedSearchPath(raw, root, call.folderPinned === true) : openedForm(raw as string, root)));
  const refused = forms.find((form): form is { why: string } => "why" in form);
  if (refused) return refused.why;
  // A search with no path walks the chat folder itself, which the probe already places: no separate lookup of the folder
  // (a lookup of a checkout's own root would place it by its parent, which is outside git).
  const targets = raws.every((raw) => raw === undefined) ? [] : forms.map((form) => (form as { path: string }).path);
  let places: (RealPlace | null)[];
  try {
    places = await locate([`${root}/${PROBE}`, ...targets]);
  } catch (error) {
    return `the app couldn't find where it really reads (${error instanceof Error ? error.message : String(error)})`;
  }
  const home = places[0];
  // Round 7, usability: a chat outside git is judged by where each read really lands, every link followed.
  if (!home)
    return outsideGitStays(paths, targets, root, canonical, (real, realFolder) =>
      credentialPath(real) || dotOutside(real, realFolder) ? `${real} is a login or config file` : null,
    );
  if (!home.relative.endsWith(PROBE)) return "the app couldn't place the chat's folder in a git checkout";
  const realFolder = realPath(home, home.relative.slice(0, -PROBE.length).replace(/\/+$/, ""));
  for (let i = 0; i < targets.length; i++) {
    const place = places[i + 1];
    if (!place) return `the app couldn't place ${paths[i]} in a git checkout, so it can't tell where it really reads`;
    const real = realPath(place);
    if (credentialPath(real) || dotOutside(real, realFolder)) return `${paths[i]} really reads ${real}, a login or config file`;
    // Round 6, MED-1: a link as the last part is held when it points outside the chat's folder, whatever it points at.
    if (place.linked && !insideFolder(real, realFolder)) return `${paths[i]} is a link to ${real}, outside the chat's folder`;
    // Round 7, MED-C: a link in the middle of the path that leads out of the folder waits too. A path that names a place
    // outside the folder by its own words keeps its rule (MED-D: Ash's decision, not changed here).
    if (namedInside(targets[i], root) && !within(real, realFolder))
      return `${paths[i]} really reads ${real}, outside the chat's folder through a link`;
  }
  return null;
}

// ---- where a shell command's words really land --------------------------------------------------------------------

/**
 * Whether a shell command's words, each read as a place in the chat's folder, really land on a file the credential rules
 * allow once links are followed (round 6, MED-1). A word that is a link as its last part, or that leads out of the folder
 * through a link, waits; so does a word the app can't place. A word that isn't a path (a pattern, a revision) is placed
 * too, as a name in the folder, and is held only when that place is one.
 */
export async function bashStaysInside(
  call: ApprovalCall | undefined,
  folder: string | undefined,
  locate: Locate,
  canonical?: Canonical,
): Promise<SafeVerdict> {
  if (!call || !SHELL_TOOLS.has(call.tool)) return null;
  const words = bashWords(call);
  if (!words) return null;
  const root = folder?.replace(/\/+$/, "");
  if (!root) return "the chat has no folder of its own to run in";
  // A flag's value is a place too (`--file=x`), a short option's value is glued on (`-fnotes` is notes, as file reads it,
  // round 7, MED-B), and so is the word itself.
  const names = [...new Set(words.slice(1).flatMap((word) => [word, ...optionValues(word)]))].filter(Boolean);
  // git with no words still runs in the folder, so its folder is placed even when it names no file (round 7).
  const git = words[0] === "git";
  if (!names.length && !git) return null;
  const targets = names.map((name) => (isAbsolutePath(name) ? name : `${root}/${name}`));
  let places: (RealPlace | null)[];
  try {
    places = await locate([`${root}/${PROBE}`, ...targets]);
  } catch (error) {
    return `the app couldn't find where it really runs (${error instanceof Error ? error.message : String(error)})`;
  }
  const home = places[0];
  if (!home) {
    // Round 7, usability: outside git there is no checkout for git to run in, so git waits; any other word is judged by
    // where it really lands, every link followed.
    if (git) return "git runs in a folder outside any checkout, so it waits for Ash";
    return outsideGitStays(names, targets, root, canonical, (real, realFolder, i) => {
      // A word that is the chat's own name is judged by its words (a search's pattern is not a file).
      const own = names[i].startsWith("/") ? null : `${realFolder}/${names[i]}`;
      return own !== real && (credentialPath(real) || dotOutside(real, realFolder))
        ? `${names[i]} really reads ${real}, a login or config file`
        : null;
    });
  }
  if (!home.relative.endsWith(PROBE)) return "the app couldn't place the chat's folder in a git checkout";
  // Round 7: a git command whose folder's git folder isn't a .git folder or file waits (a planted or bare git folder).
  if (git && home.dotGit === false) return "the chat's git folder isn't a .git folder or file, so git waits for Ash";
  const realFolder = realPath(home, home.relative.slice(0, -PROBE.length).replace(/\/+$/, ""));
  for (let i = 0; i < targets.length; i++) {
    const place = places[i + 1];
    // A word whose folder is a link out of git can't be placed, so it waits (a name the command reads is always in the checkout).
    if (!place) return `${names[i]} can't be placed in a git checkout, so it waits for Ash`;
    const real = realPath(place);
    // Round 7, MED-C: a word that reaches outside the chat's folder through a link in the middle of its path waits, as a
    // link as its last part does (round 6, MED-1).
    if (!within(real, realFolder)) return `${names[i]} is a link to ${real}, outside the chat's folder`;
    // A word that is the chat's own name is judged by its words (a search's pattern is not a file); one that reached its
    // place through a link is judged by where it really is.
    const own = names[i].startsWith("/") ? null : `${realFolder}/${names[i]}`;
    if (own !== real && (credentialPath(real) || dotOutside(real, realFolder))) return `${names[i]} really reads ${real}, a login or config file`;
  }
  return null;
}

/** The lookup check for whatever a tool call touches: an edit's real place, a read's or search's, or a shell command's (round 5, M2; round 6, MED-1). */
export function placeStaysInside(
  call: ApprovalCall | undefined,
  folder: string | undefined,
  locate: Locate,
  canonical?: Canonical,
): Promise<SafeVerdict> {
  if (call && EDIT_TOOLS.has(call.tool)) return editStaysInside(call, folder, locate, canonical);
  if (call && SHELL_TOOLS.has(call.tool)) return bashStaysInside(call, folder, locate, canonical);
  return readStaysInside(call, folder, locate, canonical);
}
