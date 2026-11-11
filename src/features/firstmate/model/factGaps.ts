// WP-145: fact gaps before a worker's done counts.
//
// The cases follow AgentMon's Done Gate (codenotary/agentmon-live, Apache-2.0,
// commit 296502feec4707f6f1a8e8b9383f8fccc3aef2ea): a failed check, a check that
// went stale after a later edit, a pass claim with no run after the last code
// edit, an open to-do, and an edited package no test reached. Docs-only edits
// are not coverage gaps. Hivra's own wording. Not a line-by-line copy.

import type { Block } from "../../sessions/model/session";

/** A lint, a type check or a build fails the turn. A test also covers a package. */
type CommandRole = "check" | "test";

type Invocation = {
  program: string;
  args: string[];
  /** A `cd` earlier in the same command, when there was one. */
  cwd?: string;
  /** True when this command's output is piped. The pipe's exit status is not the runner's. */
  piped: boolean;
  /** True when a pass of this command is not the runner's own status. */
  masked: boolean;
};

const MASKED = "A piped or masked run does not count.";

const DOC_EXT = new Set(["md", "mdx", "rst", "adoc", "txt"]);
const DOC_NAME = new Set(["readme", "license", "licence", "notice", "changelog", "contributing", "authors"]);

const MAX_CHECKS = 40;
const MAX_EDITS = 80;
const MAX_TODOS = 40;
const MAX_ANSWER = 8000;
const MAX_COMMAND = 2000;
const MAX_DISPLAY = 80;
const MAX_PATH = 500;
const MAX_TODO = 160;
const MAX_PACKAGE = 60;

export type CheckStatus = "passed" | "failed" | "running";

export type FactCheck = {
  command: string;
  status: CheckStatus;
  at: number;
};

export type FactEdit = {
  path: string;
  at: number;
};

export type FactTodo = {
  text: string;
  open: boolean;
};

/** One turn's facts. Values from a transcript or another agent are untrusted and capped. */
export type FactTurn = {
  checks: FactCheck[];
  edits: FactEdit[];
  todos: FactTodo[];
  answer: string;
};

/** Which pass claims the answer makes. Absent means it made none. */
export type PassClaim = {
  tests?: boolean;
  build?: boolean;
};

type StoredCheck = FactCheck & { display: string };

const CHECK_STATUS = new Set<CheckStatus>(["passed", "failed", "running"]);

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function stripControls(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "");
}

function oneLine(value: string, max: number): string {
  const line = stripControls(value).split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return [...line].slice(0, max).join("");
}

function segmentsOf(path: string): string[] {
  return stripControls(path)
    .split(/[/\\]+/)
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..");
}

const INTERIOR = new Set([
  "src",
  "crates",
  "packages",
  "apps",
  "features",
  "lib",
  "app",
  "test",
  "tests",
  "host",
  "scripts",
]);

/** `docs` at the checkout root. A folder named docs under source is code. `src/docs.ts` is a filename. */
function docsAtCheckoutRoot(segments: readonly string[]): boolean {
  if (segments[0]?.toLowerCase() === "docs") return true;
  const at = segments.findIndex((part) => part.toLowerCase() === "docs");
  if (at < 0) return false;
  return !segments.slice(0, at).some((part) => INTERIOR.has(part.toLowerCase()));
}

/** A docs path is not a coverage target and does not make an earlier test stale. `src/docs.ts` is code. */
export function isDocsPath(path: string): boolean {
  const segments = segmentsOf(path);
  if (segments.length === 0) return false;
  if (docsAtCheckoutRoot(segments)) return true;
  const base = segments[segments.length - 1].toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "";
  if (DOC_EXT.has(ext)) return true;
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  return DOC_NAME.has(stem);
}

function validPackage(name: string): string | undefined {
  const cleaned = stripControls(name).trim();
  if (!cleaned || [...cleaned].length > MAX_PACKAGE) return undefined;
  if (cleaned === "." || cleaned === ".." || /[/\\]/.test(cleaned)) return undefined;
  if (!/^[\p{L}\p{N}._-]+$/u.test(cleaned)) return undefined;
  return cleaned;
}

/**
 * The package a path belongs to. `packages/`, `crates/` and `apps/` name it, then `src/features/`, then the parent
 * directory. A bare filename has none. `..` is dropped, not resolved, and nothing is read from disk.
 */
export function packageOf(path: string): string | undefined {
  const segments = segmentsOf(path);
  if (segments.length < 2) return undefined;
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i].toLowerCase();
    if (dir === "packages" || dir === "crates" || dir === "apps") return validPackage(segments[i + 1]);
  }
  for (let i = 0; i < segments.length - 2; i++) {
    if (segments[i].toLowerCase() === "src" && segments[i + 1].toLowerCase() === "features") {
      return validPackage(segments[i + 2]);
    }
  }
  return validPackage(segments[segments.length - 2]);
}

function looksLikePath(token: string): boolean {
  return /[/\\]/.test(token) && !token.startsWith("-");
}

/** A line break is its own command, joined with `;`. `&&` would hide a failure on the line above. */
function commandText(raw: string): string {
  const separated = raw.replace(/\r\n|\n|\r/g, " ; ").replace(/\t/g, " ");
  return oneLine(separated, MAX_COMMAND);
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function splitOutsideQuotes(text: string, at: (chars: string[], i: number) => number): string[] {
  const chars = [...text];
  const out: string[] = [];
  let start = 0;
  let i = 0;
  let quote: '"' | "'" | undefined;
  while (i < chars.length) {
    const c = chars[i];
    if (quote) {
      if (c === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    const width = at(chars, i);
    if (width > 0) {
      out.push(chars.slice(start, i).join(""));
      i += width;
      start = i;
      continue;
    }
    i += 1;
  }
  out.push(chars.slice(start).join(""));
  return out;
}

type Join = "and" | "or" | "semi";

type Piece = { text: string; after?: Join };

function splitStatements(command: string): Piece[] {
  const chars = [...command];
  const out: Piece[] = [];
  let start = 0;
  let i = 0;
  let quote: '"' | "'" | undefined;
  while (i < chars.length) {
    const c = chars[i];
    if (quote) {
      if (c === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    const next = chars[i + 1];
    let join: Join | undefined;
    let width = 0;
    if (c === "&" && next === "&") {
      join = "and";
      width = 2;
    } else if (c === "|" && next === "|") {
      join = "or";
      width = 2;
    } else if (c === ";") {
      join = "semi";
      width = 1;
    }
    if (join && width > 0) {
      out.push({ text: chars.slice(start, i).join(""), after: join });
      i += width;
      start = i;
      continue;
    }
    i += 1;
  }
  out.push({ text: chars.slice(start).join("") });
  return out;
}

function splitPipes(statement: string): string[] {
  return splitOutsideQuotes(statement, (chars, i) => {
    if (chars[i] === "|" && chars[i + 1] !== "|") return 1;
    return 0;
  });
}

function programAndArgs(tokens: string[]): { program: string; args: string[] } {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith("-") && token.includes("=") && !token.includes("/") && !token.includes("\\")) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= tokens.length) return { program: "", args: [] };
  return { program: tokens[i], args: tokens.slice(i + 1) };
}

/** `set -o pipefail` and `set -euo pipefail` make the pipe's status the runner's. `set +o pipefail` turns that off. */
function pipefailChange(statement: string): boolean | undefined {
  const tokens = tokenize(statement.trim());
  if (tokens[0] !== "set") return undefined;
  const rest = tokens.slice(1);
  if (rest[0] === "+o" && rest[1] === "pipefail") return false;
  if (rest[0] === "-o" && rest[1] === "pipefail") return true;
  const enables =
    rest.includes("pipefail") &&
    rest.some((token) => token.startsWith("-") && !token.startsWith("--") && token.slice(1).includes("o"));
  return enables ? true : undefined;
}

function pipefailBefore(pieces: readonly Piece[]): boolean[] {
  let on = false;
  const before: boolean[] = [];
  for (const piece of pieces) {
    before.push(on);
    const next = pipefailChange(piece.text);
    if (next !== undefined) on = next;
  }
  return before;
}

/** A pass counts only when every separator after the runner is `&&` (or there is none). */
function separatorsAfterAreAnd(pieces: readonly Piece[], index: number): boolean {
  return pieces.slice(index).every((piece) => piece.after === undefined || piece.after === "and");
}

function invocations(command: string): Invocation[] {
  const pieces = splitStatements(command);
  const pipefail = pipefailBefore(pieces);
  let cwd: string | undefined;
  const out: Invocation[] = [];
  pieces.forEach((piece, index) => {
    const stages = splitPipes(piece.text);
    const piped = stages.length > 1;
    const stage = stages[0];
    if (stage === undefined) return;
    const { program, args } = programAndArgs(tokenize(stage));
    if (!program) return;
    const pipeMasks = piped && !pipefail[index];
    const tailMasks = !separatorsAfterAreAnd(pieces, index);
    const invocation: Invocation = { program, args, cwd, piped, masked: pipeMasks || tailMasks };
    if (!piped && program.toLowerCase() === "cd") {
      const dir = args[0];
      if (dir && !dir.startsWith("-")) cwd = dir;
    }
    out.push(invocation);
  });
  return out;
}

function firstPositional(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function npmRole(args: readonly string[]): CommandRole | undefined {
  const script = args[0]?.toLowerCase() === "run" ? args[1] : args[0];
  if (!script) return undefined;
  const name = script.toLowerCase();
  // `npm run check` is this repo's full check. `check:web` and `check:rust` are the same family.
  // `native:check` is not: only a script named `check` or starting with `check:` runs the tests.
  if (name === "test" || name.endsWith(":test") || name === "check" || name.startsWith("check:")) return "test";
  if (name === "lint" || name === "typecheck" || name.endsWith(":check")) return "check";
  return undefined;
}

function cargoRole(args: readonly string[]): CommandRole | undefined {
  switch (firstPositional(args)?.toLowerCase()) {
    case "test":
    case "nextest":
      return "test";
    case "check":
    case "clippy":
    case "build":
      return "check";
    default:
      return undefined;
  }
}

/** A runner that compiles, prints a version, or lists tests did not run them. */
function runsNoTests(args: readonly string[]): boolean {
  return args.some((arg) => {
    const name = arg.split("=", 1)[0] ?? arg;
    return (
      name === "--no-run" ||
      name === "--version" ||
      name === "-V" ||
      name === "--listTests" ||
      name === "--list-tests" ||
      name === "--showConfig" ||
      name === "--show-config" ||
      name === "--collect-only" ||
      name === "--help" ||
      name === "-h"
    );
  });
}

function roleOf(invocation: Invocation): CommandRole | undefined {
  const role = commandRole(invocation);
  if (role === "test" && runsNoTests(invocation.args)) return "check";
  return role;
}

function commandRole(invocation: Invocation): CommandRole | undefined {
  const program = invocation.program.toLowerCase();
  const tool = program === "npx" ? (firstPositional(invocation.args)?.toLowerCase() ?? "") : program;
  switch (tool) {
    case "vitest":
    case "jest":
    case "pytest":
    case "playwright":
    case "cypress":
      return "test";
    case "tsc":
    case "eslint":
    case "biome":
    case "ruff":
    case "mypy":
      return "check";
    case "cargo":
      return cargoRole(invocation.args);
    case "go":
    case "swift":
      return firstPositional(invocation.args)?.toLowerCase() === "test" ? "test" : undefined;
    case "make": {
      const target = firstPositional(invocation.args)?.toLowerCase();
      if (target === "test") return "test";
      if (target === "check" || target === "verify") return "check";
      return undefined;
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return npmRole(invocation.args);
    default:
      return undefined;
  }
}

function countsAsCheck(command: string, status: CheckStatus): boolean {
  if (!CHECK_STATUS.has(status)) return false;
  // A masked pass is kept so the send-back can say why it does not count. It is not evidence.
  return invocations(command).some((invocation) => roleOf(invocation) !== undefined);
}

function isTestCommand(command: string): boolean {
  return invocations(command).some((invocation) => !invocation.masked && roleOf(invocation) === "test");
}

/** The command names a test runner, and every one of those runs is masked. */
function commandMasksAPass(command: string): boolean {
  let sawTest = false;
  let sawReal = false;
  for (const invocation of invocations(command)) {
    if (roleOf(invocation) !== "test") continue;
    sawTest = true;
    if (!invocation.masked) sawReal = true;
  }
  return sawTest && !sawReal;
}

function pathTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) {
      const eq = token.indexOf("=");
      const value = eq >= 0 ? token.slice(eq + 1) : "";
      if (value && looksLikePath(value)) out.push(value);
      continue;
    }
    if (looksLikePath(token)) out.push(token);
  }
  return out;
}

function namedPackages(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-p" || token === "--package") {
      const next = tokens[i + 1];
      if (next && !next.startsWith("-")) out.push(next);
    } else if (token.startsWith("-p=") || token.startsWith("--package=")) {
      out.push(token.slice(token.indexOf("=") + 1));
    }
  }
  return out;
}

function parentDir(path: string): string | undefined {
  const segments = segmentsOf(path);
  if (segments.length < 2) return undefined;
  return segments.slice(0, -1).join("/");
}

function manifestDir(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--manifest-path=")) return parentDir(arg.slice("--manifest-path=".length));
    if (arg === "--manifest-path") return parentDir(args[i + 1] ?? "");
  }
  return undefined;
}

/** The root is a run of path segments, with at least one segment after it. */
function pathUnder(root: string, path: string): boolean {
  const rootSegs = segmentsOf(root);
  const pathSegs = segmentsOf(path);
  const width = rootSegs.length;
  if (width === 0 || pathSegs.length <= width) return false;
  for (let index = 0; index + width < pathSegs.length; index++) {
    const same = rootSegs.every((part, offset) => part.toLowerCase() === pathSegs[index + offset]?.toLowerCase());
    if (same) return true;
  }
  return false;
}

function workspaceMember(path: string): string | undefined {
  const segments = segmentsOf(path);
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i].toLowerCase();
    if (dir === "crates" || dir === "packages" || dir === "apps") return validPackage(segments[i + 1]);
  }
  return undefined;
}

function cargoRoot(invocation: Invocation): string | undefined {
  if (invocation.program.toLowerCase() !== "cargo") return undefined;
  const sub = invocation.args[0]?.toLowerCase();
  if (sub !== "test" && sub !== "nextest") return undefined;
  return manifestDir(invocation.args) ?? invocation.cwd;
}

function cargoRootCovers(invocation: Invocation, root: string, edited: string): boolean {
  if (!pathUnder(root, edited)) return false;
  const member = workspaceMember(edited);
  if (!member) return true;
  return namedPackages(invocation.args).some((name) => name === member);
}

function invocationReaches(invocation: Invocation, pkg: string, edited: string): boolean {
  if (invocation.masked || roleOf(invocation) !== "test") return false;
  const root = cargoRoot(invocation);
  if (root) return cargoRootCovers(invocation, root, edited);
  const named = namedPackages(invocation.args);
  const paths = pathTokens(invocation.args);
  if (named.length === 0 && paths.length === 0) return true;
  if (named.some((name) => name === pkg)) return true;
  return paths.some((path) => packageOf(path) === pkg);
}

/** A project-wide test reaches every package. A path, a `-p` name, or a cargo root reaches only what it covers. */
function testReaches(command: string, pkg: string, edited: string): boolean {
  return invocations(command).some((invocation) => invocationReaches(invocation, pkg, edited));
}

function sanitizeCheck(raw: unknown): StoredCheck | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<FactCheck>;
  if (row.status !== "passed" && row.status !== "failed" && row.status !== "running") return undefined;
  if (!CHECK_STATUS.has(row.status)) return undefined;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return undefined;
  if (typeof row.command !== "string") return undefined;
  const command = commandText(row.command);
  if (!command || !countsAsCheck(command, row.status)) return undefined;
  const display = [...command].slice(0, MAX_DISPLAY).join("").trimEnd();
  return { command, display, status: row.status, at: row.at };
}

function sanitizeEdit(raw: unknown): FactEdit | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<FactEdit>;
  if (typeof row.path !== "string" || typeof row.at !== "number" || !Number.isFinite(row.at)) return undefined;
  const path = stripControls(row.path).trim();
  if (!path || [...path].length > MAX_PATH) return undefined;
  return { path, at: row.at };
}

function sanitizeTodo(raw: unknown): FactTodo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<FactTodo>;
  if (typeof row.text !== "string" || typeof row.open !== "boolean") return undefined;
  const text = oneLine(row.text, MAX_TODO);
  if (!text) return undefined;
  return { text, open: row.open };
}

function cleanAnswer(answer: unknown): string {
  if (typeof answer !== "string") return "";
  const kept = answer.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return [...kept].slice(0, MAX_ANSWER).join("");
}

/**
 * Only the latest run of each command decides anything (`failureGaps` reads the last one per display), so repeats
 * collapse before the cap, as in Rust's `latest_per_command`. Forty type checks cannot push a failing test out of what
 * is sent. Order is the order of each command's latest run.
 */
function latestPerCommand(checks: readonly StoredCheck[]): StoredCheck[] {
  const last = new Map<string, number>();
  checks.forEach((check, index) => last.set(check.display, index));
  return checks.filter((check, index) => last.get(check.display) === index);
}

function sanitize(turn: FactTurn | undefined): {
  checks: StoredCheck[];
  edits: FactEdit[];
  todos: FactTodo[];
  answer: string;
} {
  return {
    checks: latestPerCommand(
      asArray(turn?.checks)
        .map(sanitizeCheck)
        .filter((row): row is StoredCheck => !!row),
    ).slice(-MAX_CHECKS),
    edits: asArray(turn?.edits).map(sanitizeEdit).filter((row): row is FactEdit => !!row).slice(-MAX_EDITS),
    todos: asArray(turn?.todos).map(sanitizeTodo).filter((row): row is FactTodo => !!row).slice(0, MAX_TODOS),
    answer: cleanAnswer(turn?.answer),
  };
}

function lastCodeAt(edits: readonly FactEdit[]): number | undefined {
  let last: number | undefined;
  for (const edit of edits) {
    if (isDocsPath(edit.path)) continue;
    if (last === undefined || edit.at > last) last = edit.at;
  }
  return last;
}

function lineNegated(line: string): boolean {
  return /\b(?:not|no|never|didn't|don't|haven't|failed|fail)\b/i.test(line);
}

function claimsWord(line: string, what: RegExp): boolean {
  if (lineNegated(line)) return false;
  return what.test(line) && /\b(?:pass(?:ed|es|ing)?|green)\b/i.test(line);
}

/** A tests or build pass the answer states, one line at a time. A denial on the same line cancels that line. */
export function claimOf(answer: string): PassClaim | undefined {
  const text = cleanAnswer(answer);
  let tests = false;
  let build = false;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    if (claimsWord(line, /\btests?\b/i)) tests = true;
    if (claimsWord(line, /\b(?:build|typecheck|type check)\b/i)) build = true;
  }
  if (!tests && !build) return undefined;
  const claim: PassClaim = {};
  if (tests) claim.tests = true;
  if (build) claim.build = true;
  return claim;
}

function failureGaps(checks: readonly StoredCheck[]): string[] {
  const order: string[] = [];
  const last = new Map<string, StoredCheck>();
  for (const check of checks) {
    if (!last.has(check.display)) order.push(check.display);
    last.set(check.display, check);
  }
  const gaps: string[] = [];
  for (const key of order) {
    const check = last.get(key);
    if (check?.status === "failed") gaps.push(`A check failed this turn (${check.display}).`);
  }
  return gaps;
}

function stale(checks: readonly StoredCheck[], edits: readonly FactEdit[]): boolean {
  const last = lastCodeAt(edits);
  if (last === undefined) return false;
  const tests = checks.filter((check) => isTestCommand(check.command));
  const passedBefore = tests.some((check) => check.status === "passed" && check.at <= last);
  const finishedAfter = tests.some(
    (check) => (check.status === "passed" || check.status === "failed") && check.at > last,
  );
  return passedBefore && !finishedAfter;
}

/** A finished check after the last code edit. With no code edit, a pass anywhere stands. A running check never does. */
function countsAsEvidence(check: StoredCheck): boolean {
  if (check.status === "failed") return true;
  if (check.status === "passed") return !commandMasksAPass(check.command);
  return false;
}

function claimHasEvidence(checks: readonly StoredCheck[], edits: readonly FactEdit[]): boolean {
  const last = lastCodeAt(edits);
  if (last === undefined) return checks.some((check) => check.status === "passed" && !commandMasksAPass(check.command));
  return checks.some((check) => countsAsEvidence(check) && check.at > last);
}

function maskedPassStandsIn(checks: readonly StoredCheck[]): boolean {
  let sawMasked = false;
  let sawReal = false;
  for (const check of checks) {
    if (check.status !== "passed") continue;
    if (isTestCommand(check.command)) sawReal = true;
    else if (commandMasksAPass(check.command)) sawMasked = true;
  }
  return sawMasked && !sawReal;
}

function openTodos(todos: readonly FactTodo[]): string[] {
  const seen = new Set<string>();
  const open: string[] = [];
  for (const todo of todos) {
    if (!todo.open || seen.has(todo.text)) continue;
    seen.add(todo.text);
    open.push(todo.text);
  }
  return open;
}

/** Edited packages no finished test reached. Docs-only edits are skipped. */
export function coverageGaps(turn: FactTurn): string[] {
  const clean = sanitize(turn);
  const seen = new Set<string>();
  const gaps: string[] = [];
  for (const edit of clean.edits) {
    if (isDocsPath(edit.path)) continue;
    const pkg = packageOf(edit.path);
    if (!pkg || seen.has(pkg)) continue;
    seen.add(pkg);
    const reached = clean.checks.some(
      (check) =>
        (check.status === "passed" || check.status === "failed") && testReaches(check.command, pkg, edit.path),
    );
    if (!reached) gaps.push(`No test reached ${pkg}.`);
  }
  return gaps;
}

/** Every fact gap in this turn, in a stable order. Empty when the facts support done. */
export function doneGaps(turn: FactTurn): string[] {
  const clean = sanitize(turn);
  const gaps = [...failureGaps(clean.checks)];
  if (maskedPassStandsIn(clean.checks)) gaps.push(MASKED);
  if (stale(clean.checks, clean.edits)) gaps.push("Tests went stale after the last edit.");
  const claim = claimOf(clean.answer);
  if (claim && !claimHasEvidence(clean.checks, clean.edits)) {
    if (claim.tests) gaps.push("The answer says the tests passed, but no check ran after the last edit.");
    if (claim.build) gaps.push("The answer says the build passed, but no check ran after the last edit.");
  }
  const open = openTodos(clean.todos);
  if (open.length === 1) gaps.push(`There is still an open to-do: ${open[0]}.`);
  else if (open.length > 1) gaps.push(`There are still ${open.length} open to-dos.`);
  gaps.push(...coverageGaps(turn));
  return gaps;
}

/** The first line a person sees. One gap keeps its sentence. More than one counts the rest. */
export function sentBackReason(gaps: readonly string[]): string {
  const first = gaps[0];
  if (!first) return "";
  const lead = `${first.charAt(0).toLowerCase()}${first.slice(1)}`;
  if (gaps.length === 1) return `Sent back: ${lead}`;
  return `Sent back: ${lead} Also ${gaps.length - 1} more.`;
}

/**
 * What is stored on the gate and sent back to the worker. One gap is the sentence alone. More than one repeats the
 * list under it, so the fix round still has every gap.
 */
export function factSummary(gaps: readonly string[]): string {
  if (gaps.length === 0) return "";
  const head = sentBackReason(gaps);
  if (gaps.length === 1) return head;
  return `${head}\n${gaps.join("\n")}`;
}

function changedSomething(block: Block): boolean {
  const tool = block.tool;
  if (!tool) return false;
  return (
    tool.kind === "edit" ||
    tool.kind === "write" ||
    tool.preview?.kind === "write" ||
    /^(?:edit|write|multi_?edit|apply_?patch|create|delete|move|rename)\b/i.test(tool.title ?? "")
  );
}

function editPaths(block: Block): string[] {
  if (!changedSomething(block)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (path: string | undefined) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const path of block.tool?.paths ?? []) add(path);
  add(block.tool?.preview?.path);
  for (const token of (block.tool?.title ?? "").split(/\s+/)) {
    const clean = token.replace(/^["'`(\[]+|["'`)\].,;:]+$/g, "");
    if (looksLikePath(clean)) add(clean);
  }
  return out;
}

/**
 * A `sed -i` (or `--in-place`) writes the files after its script. The script itself is not a path. `beforeTest` is true
 * when a real test run comes later in the same command, so that run is after the edit.
 */
function shellEdits(command: string): { path: string; beforeTest: boolean }[] {
  if (!command) return [];
  const out: { path: string; beforeTest: boolean }[] = [];
  const all = invocations(commandText(command));
  all.forEach((invocation, index) => {
    if (invocation.piped || invocation.program.toLowerCase() !== "sed") return;
    const beforeTest = all
      .slice(index + 1)
      .some((later) => !later.masked && roleOf(later) === "test");
    const inplace = invocation.args.some(
      (arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="),
    );
    if (!inplace) return;
    const operands = invocation.args.filter((arg) => !arg.startsWith("-"));
    for (const file of operands.slice(1)) {
      if (looksLikePath(file) || /\.[A-Za-z0-9]+$/.test(file)) out.push({ path: file, beforeTest });
    }
  });
  return out;
}

function commandOf(block: Block): string {
  const tool = block.tool;
  if (!tool) return "";
  const shell = tool.preview?.kind === "shell" ? tool.preview.title : undefined;
  return (tool.command ?? tool.title ?? shell ?? "").trim();
}

function statusOf(status: string | undefined): CheckStatus | undefined {
  const word = (status ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!word) return undefined;
  if (word === "pending" || word === "running" || word === "inprogress") return "running";
  if (word === "completed" || word === "complete" || word === "success" || word === "passed" || word === "ok") {
    return "passed";
  }
  if (word === "cancelled" || word === "canceled") return undefined;
  return "failed";
}

function currentTurn(blocks: readonly Block[]): Block[] {
  let start = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role === "user" && !block.internal && !block.draft) {
      start = i;
      break;
    }
  }
  return start < 0 ? [...blocks] : blocks.slice(start + 1);
}

/**
 * Facts for the turn after the last real user message. A check still running stays running. The latest to-do list
 * replaces earlier ones. `at` is the block's place in that turn.
 */
export function factsFromBlocks(blocks: readonly Block[], answer: string): FactTurn {
  const turn = currentTurn(blocks);
  const checks: FactCheck[] = [];
  const edits: FactEdit[] = [];
  let todos: FactTodo[] | undefined;
  turn.forEach((block, at) => {
    const command = commandOf(block);
    const status = statusOf(block.tool?.status);
    if (command && status && countsAsCheck(commandText(command), status)) {
      checks.push({ command, status, at });
    }
    for (const path of editPaths(block)) edits.push({ path, at });
    for (const { path, beforeTest } of shellEdits(command)) {
      // An edit and then a test in one command: the edit is placed just before this block's run.
      const editAt = beforeTest ? at - 0.5 : at;
      if (!edits.some((edit) => edit.path === path && edit.at === editAt)) edits.push({ path, at: editAt });
    }
    if (block.taskList) {
      todos = block.taskList.items.flatMap((item) => {
        const text = item.text?.trim() ?? "";
        if (!text) return [];
        const open = item.status === "pending" || item.status === "in_progress";
        return [{ text, open }];
      });
    }
  });
  const clean = sanitize({
    checks,
    edits,
    todos: todos ?? [],
    answer,
  });
  return {
    checks: clean.checks.map(({ command, status, at }) => ({ command, status, at })),
    edits: clean.edits,
    todos: clean.todos,
    answer: clean.answer,
  };
}
