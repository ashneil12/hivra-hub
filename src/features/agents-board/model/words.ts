// Words a row may show. A path, a raw id, or the word "stuck" never gets through.

import { howLong } from "../../crew/model/rows";
import { formatUsd } from "../../usage/model/history";
import type { BoardRole, BoardState } from "./tree";

const STUCK = /\bstuck\b/gi;

export function plainWords(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")[0]
    .replace(/(\d)\s*[—–]\s*(?=\d)/g, "$1-")
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/[—–]/g, ", ")
    .replace(STUCK, "stopped")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

export function looksLikePath(value: string): boolean {
  const text = value.trim();
  return text.startsWith("~") || /[\\/]/.test(text) || /^[A-Za-z]:/.test(text);
}

export function looksLikeId(value: string): boolean {
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(value);
}

export function rowName(
  role: BoardRole,
  name: string,
  projectName: string | null,
  department: string | null,
): string {
  if (role === "captain") return "Chief of Staff";
  const cleaned = plainWords(name ?? "");
  const named =
    cleaned && !looksLikePath(cleaned) && !looksLikeId(cleaned) && !/ lead$/i.test(cleaned)
      ? cleaned
      : "";
  if (role === "mate") {
    if (named) return named.slice(0, 80);
    const dept = (department ?? "").trim().toLowerCase();
    if (dept === "marketing") return "Marketing";
    if (dept === "ops") return "Ops";
    return "Coding";
  }
  if (named) return named.slice(0, 80);
  const project = projectName ? plainWords(projectName) : "";
  if (project && !looksLikePath(project) && !looksLikeId(project)) return project.slice(0, 80);
  return "Untitled";
}

const SECRET = /sk-|api[_ -]?key|\btoken\b|bearer /i;
const STACK = /^\s*at\b/;
const CODE = /\b(?:stopFailed|unloaded|nonce|tasks\.cancel|sessionId|delegationId)\b/i;
const FILE = /(?:^|[\s(])(?:~\/|\/|[A-Za-z]:\\)|\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|rs|json)(?::\d+)?\b/;

const SWAPS: readonly (readonly [RegExp, string])[] = [
  [/\bis blocked\b/gi, "needs you"],
  [/\bare blocked\b/gi, "need you"],
  [/\bblocked\b/gi, "needs you"],
  [/\brunning\b/gi, "working"],
  [/\bfailed\b/gi, "did not finish"],
  [/\bcompleted\b/gi, "done"],
  [/\bmonos?\b/gi, "first mate"],
  [/\bagents?\b/gi, "first mate"],
  [/\bbots?\b/gi, "first mate"],
  [/\bcoordinators?\b/gi, "Chief of Staff"],
  [/\bcaptains?\b/gi, "Chief of Staff"],
];

/** A failure line a person may read. A stack, a secret, a path or a code name is left out. */
export function plainFailure(value: string | null | undefined): string | null {
  const raw = (value ?? "").replace(/\r\n/g, "\n");
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text || STACK.test(text) || SECRET.test(text) || CODE.test(text) || FILE.test(text)) continue;
    let next = plainWords(text);
    for (const [pattern, word] of SWAPS) next = next.replace(pattern, word);
    next = next.replace(/[ \t]{2,}/g, " ").replace(/^[,\s]+|[,\s]+$/g, "").trim();
    if (!next || looksLikePath(next) || looksLikeId(next)) continue;
    return next.length > 240 ? next.slice(0, 240).trim() : next;
  }
  return null;
}

/** The row's own brief wins. A status notice is a failure reason and has to read as plain words. */
export function workerBrief(brief: string | null | undefined, notice: string | null | undefined): string | null {
  const own = (brief ?? "").replace(/\r/g, "").trim();
  if (own) return own;
  return plainFailure(notice);
}

export function taskWords(value: string | null | undefined): string | null {
  const text = plainWords(value ?? "");
  if (!text) return null;
  return text.length > 80 ? text.slice(0, 80).trim() : text;
}

export function costLabel(costUsd: number | null | undefined): string | null {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) return null;
  const text = formatUsd(costUsd);
  return text || null;
}

export function timeLabel(startedAt: number | null | undefined, now: number): string | null {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  const text = howLong(startedAt, now);
  return text || null;
}

export function checksLabel(
  checks: { failing?: number; pending?: number; passed?: boolean } | null | undefined,
): string | null {
  if (!checks) return null;
  const failing = typeof checks.failing === "number" && Number.isFinite(checks.failing) ? Math.max(0, Math.floor(checks.failing)) : 0;
  if (failing > 0) return failing === 1 ? "1 check failing" : `${failing} checks failing`;
  if (checks.passed === true) return "checks green";
  return null;
}

export function prNumberOf(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/** How a parent says what is under it. Not a chip: the row's own state keeps the chip. */
export function rollupText(count: number, state: BoardState): string | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (state === "needs-you") return count === 1 ? "1 needs you below" : `${count} need you below`;
  if (state === "working") return count === 1 ? "1 working" : `${count} working`;
  if (state === "done") return count === 1 ? "1 done" : `${count} done`;
  return count === 1 ? "1 idle" : `${count} idle`;
}

/** The chip. A failed or cancelled worker is Needs you. The word stuck is never a state. */
export function boardState(input: { status?: string | null; state?: string | null }): BoardState {
  const status = (input.status ?? "").trim().toLowerCase();
  if (status === "needs-you" || status === "failed") return "needs-you";
  if (status === "working") return "working";
  if (status === "done") return "done";
  if (status === "paused") return "idle";
  const state = (input.state ?? "").trim().toLowerCase();
  if (state === "failed" || state === "cancelled" || state === "stopped") return "needs-you";
  if (state === "question") return "needs-you";
  if (state === "running") return "working";
  if (state === "completed") return "done";
  return "idle";
}
