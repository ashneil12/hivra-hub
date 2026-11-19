// SC-4: a brief's own runnable checks, its commit stamp and its do-not-touch list (docs/specs/shipping-confidence-gap-spec.md
// section 4a). The engine is Rust (src-tauri/src/firstmate/brief_checks.rs): the gates run the lines after the project's
// checks, write each result back to the delegation row (only the app sets `passes`), and done_check fails a change under
// the do-not-touch list. This module is what the webview does before a worker starts: it reads the lines, the list and the
// in-scope paths a first mate sent, refuses a bad one in the same words Rust uses, and writes the sections of the worker's
// brief they become (renderBrief in brief.ts places them).
//
// The first mate's `checks` holds both kinds of entry it always did and the new one: a plain name is the id of one of the
// project's own checks (WP-40, completionGates.ts), an object is a line `{what, command, expect}` of the brief's own.
import type { TestingMode } from "../../delivery/model/testingMode";

/** At most this many check lines on one brief; a one-line bug gets one. */
export const CHECK_LINES_MAX = 12;
/** The longest what, command, expect or path, in characters. */
export const CHECK_TEXT_MAX = 400;
/** The most paths on a do-not-touch list. */
export const LEAVE_MAX = 50;

/** One line of a brief's own checks: what must be true, the command that shows it, and what it must print or exit with. */
export type CheckLine = {
  what: string;
  command: string;
  /** Text the output must contain, or `exit N` for the exit code it must end with. Absent: exit 0. */
  expect?: string;
};

/** Words of one line, whatever whitespace and line endings it was written with (U+0085 too, which Rust reads as space). */
function oneLine(text: string): string {
  return text.split(/[\s\u0085]+/).filter(Boolean).join(" ");
}

function lineProblem(number: number, text: string): Error {
  return new Error(`Check line ${number}${text}`);
}

/** One entry of `checks` that is a line of the brief's own, validated. `number` is its place among the lines. */
function readLine(item: unknown, number: number): CheckLine {
  if (!item || typeof item !== "object" || Array.isArray(item))
    throw lineProblem(number, " must be {what, command, expect}.");
  const object = item as Record<string, unknown>;
  const extra = Object.keys(object).find((key) => key !== "what" && key !== "command" && key !== "expect");
  if (extra !== undefined)
    throw lineProblem(
      number,
      ` has what, command and expect only; "${extra}" isn't one. The app records whether a check passed.`,
    );
  const text = (key: "what" | "command" | "expect"): string | undefined => {
    const value = object[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw lineProblem(number, `: ${key} must be text.`);
    return value;
  };
  const what = oneLine(text("what") ?? "");
  if (!what) throw lineProblem(number, " needs what must be true (what).");
  const command = (text("command") ?? "").trim();
  if (!command) throw lineProblem(number, " needs the command that shows it (command).");
  if (/[\r\n]/.test(command))
    throw lineProblem(number, ": command is one line. Put several steps in one script, or in several check lines.");
  const rawExpect = text("expect");
  let expect: string | undefined;
  if (rawExpect !== undefined && rawExpect.trim()) {
    if (/[\r\n]/.test(rawExpect))
      throw lineProblem(number, ": expect is one line of text the output contains, or exit N.");
    expect = rawExpect.trim();
  }
  for (const [name, value] of [["what", what], ["command", command], ["expect", expect]] as const) {
    if (value !== undefined && [...value].length > CHECK_TEXT_MAX)
      throw lineProblem(number, `: ${name} is longer than ${CHECK_TEXT_MAX} characters.`);
  }
  return { what, command, ...(expect ? { expect } : {}) };
}

/**
 * The first mate's `checks`, apart: the ids of the project's own checks (plain names, trimmed, repeats and blanks
 * dropped: gateRequest holds them to its own limits) and the brief's own lines. A bad line is refused in plain words.
 */
export function splitChecks(value: unknown): { ids: string[]; lines: CheckLine[] } {
  if (value === undefined || value === null) return { ids: [], lines: [] };
  if (!Array.isArray(value))
    throw new Error("checks must be a list of check lines: {what, command, expect}, or project check names.");
  const ids: string[] = [];
  const lines: CheckLine[] = [];
  let number = 0;
  for (const item of value) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id && !ids.includes(id)) ids.push(id);
      continue;
    }
    number += 1;
    if (number > CHECK_LINES_MAX) throw new Error(`Give at most ${CHECK_LINES_MAX} check lines.`);
    const line = readLine(item, number);
    const same = (other: CheckLine) =>
      other.what === line.what && other.command === line.command && other.expect === line.expect;
    if (!lines.some(same)) lines.push(line);
  }
  return { ids, lines };
}

// ---- paths ------------------------------------------------------------------------------------------------------------------

/**
 * A path a brief names, inside the project: forward slashes, with `./` parts, doubled slashes and a trailing `/` or `/**`
 * taken out, so one path is written one way. A path that leaves the project (absolute, `..`, `~`, a drive), holds a control
 * character or is git pathspec magic is refused. Rust's `normal_path` reads a path the same way.
 */
export function normalPath(raw: string): string {
  const path = raw.trim().replace(/\\/g, "/");
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path))
    throw new Error(`${JSON.stringify(path)} has a control character.`);
  const outside = (shown: string) =>
    new Error(`"${shown}" isn't inside the project. Use a path from the project's root, like src/app.ts.`);
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) throw outside(path);
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes(".."))
    throw new Error(`"${parts.join("/")}" leaves the project (..). Use a path from the project's root.`);
  while (parts[parts.length - 1] === "**") parts.pop();
  if (!parts.length) throw new Error("Name a file or folder inside the project, not the whole project.");
  const joined = parts.join("/");
  if (joined.startsWith(":")) throw outside(joined);
  if ([...joined].length > CHECK_TEXT_MAX) throw new Error(`A path is longer than ${CHECK_TEXT_MAX} characters.`);
  return joined;
}

/** The do-not-touch list a brief names, validated: at most 50 paths inside the project, repeats dropped. */
export function leaveList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("leave must be a list of paths.");
  if (value.length > LEAVE_MAX) throw new Error(`Name at most ${LEAVE_MAX} paths in leave.`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("leave must be a list of paths.");
    const path = normalPath(item);
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * The in-scope entries of a brief, split into the ones that are paths (they go into the drift command) and the ones that
 * are not (prose like "the login flow", or a path that leaves the project): scope has always been "files or areas".
 */
export function scopePaths(scope: readonly string[]): { paths: string[]; areas: string[] } {
  const paths: string[] = [];
  const areas: string[] = [];
  for (const entry of scope) {
    const named = entry.trim();
    if (!named) continue;
    const pathLike = named.includes("/") || named.includes("\\") || !/\s/.test(named);
    let path: string | undefined;
    if (pathLike) {
      try {
        path = normalPath(named);
      } catch {
        path = undefined;
      }
    }
    if (path === undefined) areas.push(named);
    else if (!paths.includes(path)) paths.push(path);
  }
  return { paths, areas };
}

// ---- what a code brief is -----------------------------------------------------------------------------------------------------

/** A code brief says so (`code`), names gates, or names in-scope paths. The same test the full-mode refusal uses. */
export function isCodeBrief(input: { code?: unknown; gates?: unknown; scope?: unknown }): boolean {
  if (input.code === true) return true;
  if (Array.isArray(input.gates) && input.gates.length > 0) return true;
  return Array.isArray(input.scope) && input.scope.some((item) => typeof item === "string" && item.trim());
}

/** The refusal in `full` testing mode for a code brief with no check line. */
export const FULL_MODE_NEEDS_CHECKS =
  "Not sent: this project runs full checks on each task, so a code brief needs at least one check line (what, command, expect).";

/**
 * Why a brief can't go out in this project's testing mode, or undefined. Only `full` asks for lines; `mode` is undefined
 * when the app could not say (the default mode's rule: never stricter than it was told).
 */
export function checksRefusal(
  mode: TestingMode | undefined,
  codeBrief: boolean,
  lines: readonly unknown[],
): string | undefined {
  return mode === "full" && codeBrief && lines.length === 0 ? FULL_MODE_NEEDS_CHECKS : undefined;
}

// ---- the commit stamp ---------------------------------------------------------------------------------------------------------

/** A commit id (7 to 64 hex digits), lowercased; undefined for anything else. A value from disk or a window is untrusted. */
export function validStamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const stamp = value.trim();
  return /^[0-9a-fA-F]{7,64}$/.test(stamp) ? stamp.toLowerCase() : undefined;
}

/** One word for a POSIX shell: as it is when plain, else in single quotes. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9._/@%+=:,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Markdown code for `text`: a fence longer than any run of backticks inside it, padded when it starts or ends with one. */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** What the worker runs first: what moved in the in-scope paths since the brief was written. */
export function driftCommand(stamp: string, paths: readonly string[]): string {
  return `git diff --stat ${stamp}..HEAD${paths.length ? ` -- ${paths.map(shellQuote).join(" ")}` : ""}`;
}

/** The worker's brief opens with this, right after the isolation check. */
export function stampSection(stamp: string, scope: readonly string[]): string {
  const { paths } = scopePaths(scope);
  const rule = paths.length
    ? "If it shows any change"
    : "If it shows a change to a file this brief names";
  return [
    "## Before you start",
    `This brief was written against commit ${stamp}. Run ${codeSpan(driftCommand(stamp, paths))} first. ${rule}, stop: change nothing and report what moved with task_cannot, so your first mate can re-plan.`,
  ].join("\n");
}

// ---- the sections ---------------------------------------------------------------------------------------------------------------

/** The check lines the worker must pass. One list item per line, so no line can open a section of its own. */
export function checksSection(lines: readonly CheckLine[]): string {
  return [
    "## Checks that must pass",
    ...lines.map((line) => {
      const expect = line.expect ? oneLine(line.expect) : "";
      return `- ${oneLine(line.what)}: run ${codeSpan(line.command.replace(/[\r\n]+/g, " "))}${expect ? `, expect: ${expect}` : ""}`;
    }),
  ].join("\n");
}

/** The paths the worker must not change. A change to one fails its task. */
export function leaveSection(paths: readonly string[]): string {
  return [
    "## Do not touch",
    "Change none of these: don't edit, move or delete them. A change to one fails your task.",
    ...paths.map((path) => `- ${codeSpan(path.replace(/[\r\n]+/g, " "))}`),
  ].join("\n");
}
