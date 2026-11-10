// Hivra WP-15: one crew row per worker. Status is read, never computed here.

import { sameProjectPath } from "../../projects/model/recents";
import type { FirstMateStatus } from "../../monos/model/delegations";
import { knownStatus, statusWord } from "./words";

export type CrewWorkerInput = {
  id: string;
  project?: string | null;
  title?: string | null;
  status?: unknown;
  statusNotice?: string | null;
  createdAt?: number;
  settledAt?: number | null;
  updatedAt?: number;
  childSession?: string | null;
  parentId?: string | null;
  ownerSession?: string | null;
  errorClass?: string | null;
  error?: string | null;
  /** A running row's stall (`blocked` means its first mate or the worker said it cannot finish) and since when. */
  stallKind?: string | null;
  stalledAt?: number | null;
  follow?: string | null;
  brief?: string | null;
  goal?: string | null;
  /** WP-84: the shared task this crew moves, when the delegation names one. */
  taskId?: string | null;
};

export type CrewSessionInput = {
  id: string;
  harness?: string | null;
  model?: string | null;
  branch?: string | null;
  additions?: number | null;
  deletions?: number | null;
  cwd?: string | null;
  worktreeCwd?: string | null;
};

export type CrewDeliveryInput = {
  delegationId?: string | null;
  mode?: string | null;
  state?: string | null;
  url?: string | null;
  number?: number | null;
  branch?: string | null;
  checkout?: string | null;
  updatedAt?: number;
};

export type CrewChecksInput = {
  number?: number | null;
  url?: string | null;
  repo?: string | null;
  passed?: boolean;
  pending?: number;
  failed?: readonly string[];
  checks?: number;
};

export type CrewAction = "open" | "message" | "stop" | "retry" | "land" | "open-pr";

export type CrewRow = {
  id: string;
  title: string;
  cli: string | null;
  model: string | null;
  status: FirstMateStatus | null;
  statusWord: string | null;
  notice: string | null;
  howLong: string;
  branch: string | null;
  additions: number | null;
  deletions: number | null;
  prUrl: string | null;
  prNumber: number | null;
  checks: string | null;
  sessionId: string | null;
  ownerSession: string | null;
  checkout: string | null;
  actions: CrewAction[];
};

const HARNESS =
  /^(claude|codex|cursor|grok|opencode|pi|omp|fx|hermes|antigravity|devin)$/;

/** How long the work has been going, never a negative span. */
export function howLong(from: number, to: number): string {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "";
  const min = Math.floor(Math.max(0, to - from) / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return min === 1 ? "1 min" : `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

function titleOf(value: string | null | undefined): string {
  const line = (value ?? "").replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
  return line.slice(0, 120) || "Untitled work";
}

function plainToken(value: string | null | undefined, max: number): string | null {
  const text = (value ?? "").trim();
  if (!text || text.length > max) return null;
  return text;
}

const SECRET = /sk-|api[_ -]?key|\btoken\b|bearer /i;
const STACK = /^\s*at /;

/** The first line a person may read. A stack frame or a secret is skipped. Nothing plain means nothing shown. */
export function firstPlainLine(value: string | null | undefined, max = 240): string | null {
  const raw = (value ?? "").replace(/\r\n/g, "\n");
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text || STACK.test(text) || SECRET.test(text)) continue;
    return text.slice(0, max);
  }
  return null;
}

function cliOf(harness: string | null | undefined): string | null {
  const text = (harness ?? "").trim().toLowerCase();
  return HARNESS.test(text) ? text : null;
}

function countOf(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** An https pull request link, or null. Anything else is ignored. */
export function httpsUrl(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function checksWord(checks: CrewChecksInput | undefined): string | null {
  if (!checks) return null;
  const pending = countOf(checks.pending) ?? 0;
  const failed = Array.isArray(checks.failed) ? checks.failed.length : 0;
  const total = countOf(checks.checks) ?? 0;
  if (pending > 0) return pending === 1 ? "1 check still going" : `${pending} checks still going`;
  if (failed > 0) return failed === 1 ? "1 check did not pass" : `${failed} checks did not pass`;
  if (checks.passed) return "Every check passed";
  if (total === 0) return "No checks yet";
  return null;
}

function actionsFor(
  status: FirstMateStatus | null,
  delivery: CrewDeliveryInput | undefined,
  sessionId: string | null,
  checkout: string | null,
  project: string,
  ownerSession: string | null,
): CrewAction[] {
  const actions: CrewAction[] = [];
  if (sessionId) actions.push("open");
  if (status === "working" || status === "needs-you" || status === "paused") {
    // Message needs a chat to send to. Stop does not.
    if (ownerSession) actions.push("message");
    actions.push("stop");
  }
  // A failed job can be sent again. A paused one resumes by itself, so Retry would start a second worker.
  if (status === "failed") actions.push("retry");
  if (status === "done") {
    const mode = (delivery?.mode ?? "").trim();
    const state = (delivery?.state ?? "").trim();
    const landed = state === "landed" || state === "merged" || state === "closed";
    const url = httpsUrl(delivery?.url);
    // Landing writes into a copy. The project's own folder is never that copy.
    const ownCopy =
      !!checkout && !sameProjectPath(checkout.replace(/\r/g, ""), project);
    if (url) actions.push("open-pr");
    else if (!landed && ownCopy && (mode === "pr" || mode === "checked" || mode === "checked-pr")) {
      actions.push("open-pr");
    } else if (!landed && ownCopy && (mode === "local" || mode === "")) {
      actions.push("land");
    }
  }
  return actions;
}

/** Workers beneath `id`, not `id` itself. A cycle or a repeated id is visited once. */
export function workersUnder<T extends { id: string; parentId?: string | null }>(
  id: string,
  rows: readonly T[],
): T[] {
  const byParent = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.parentId || !row.id) continue;
    const list = byParent.get(row.parentId);
    if (list) list.push(row);
    else byParent.set(row.parentId, [row]);
  }
  const out: T[] = [];
  const seen = new Set<string>([id]);
  for (const queue = [id]; queue.length; ) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

function newestDelivery(
  id: string,
  deliveries: readonly CrewDeliveryInput[],
): CrewDeliveryInput | undefined {
  let best: CrewDeliveryInput | undefined;
  for (const delivery of deliveries) {
    if (delivery.delegationId !== id) continue;
    if (!best || (delivery.updatedAt ?? 0) >= (best.updatedAt ?? 0)) best = delivery;
  }
  return best;
}

function checksFor(
  delivery: CrewDeliveryInput | undefined,
  checks: readonly CrewChecksInput[],
): CrewChecksInput | undefined {
  if (!delivery) return undefined;
  const url = httpsUrl(delivery.url);
  if (url) {
    const byUrl = checks.find((item) => httpsUrl(item.url) === url);
    if (byUrl) return byUrl;
  }
  if (delivery.number == null) return undefined;
  const sameNumber = checks.filter((item) => item.number === delivery.number);
  return sameNumber.length === 1 ? sameNumber[0] : undefined;
}

function cleanPath(value: string): string {
  return value.replace(/\r/g, "").trim();
}

function inProject(row: CrewWorkerInput, project: string): boolean {
  if (typeof row.project !== "string") return false;
  const path = cleanPath(row.project);
  return path !== "" && sameProjectPath(path, project);
}

/**
 * The crew for one project, oldest first. `briefId` keeps that brief's workers only.
 * A row with no derive_status is shown without a status word. Its state is not read.
 */
export function crewRows(input: {
  project: string;
  rows: readonly CrewWorkerInput[];
  sessions?: readonly CrewSessionInput[];
  deliveries?: readonly CrewDeliveryInput[];
  checks?: readonly CrewChecksInput[];
  now: number;
  briefId?: string | null;
}): CrewRow[] {
  const project = cleanPath(input.project ?? "");
  if (!project || project === "~") return [];
  const byId = new Map<string, CrewWorkerInput>();
  for (const row of input.rows) {
    if (!row || typeof row.id !== "string" || !row.id.trim()) continue;
    if (row.follow === "lead") continue;
    const previous = byId.get(row.id);
    if (!previous || (row.updatedAt ?? 0) >= (previous.updatedAt ?? 0)) byId.set(row.id, row);
  }
  const unique = [...byId.values()];
  const allowed = input.briefId
    ? new Set(workersUnder(input.briefId, unique).map((row) => row.id))
    : null;
  const sessions = new Map((input.sessions ?? []).map((session) => [session.id, session]));
  const out: CrewRow[] = [];
  for (const row of unique) {
    if (allowed && !allowed.has(row.id)) continue;
    // A brief filter never lists another project's worker, even when it sits under the brief.
    if (!inProject(row, project)) continue;
    const session = row.childSession ? sessions.get(row.childSession) : undefined;
    const delivery = newestDelivery(row.id, input.deliveries ?? []);
    const status = knownStatus(row.status);
    const ended = status === "done" || status === "failed";
    const from = typeof row.createdAt === "number" ? row.createdAt : Number.NaN;
    const to = ended
      ? typeof row.settledAt === "number"
        ? row.settledAt
        : typeof row.updatedAt === "number"
          ? row.updatedAt
          : input.now
      : input.now;
    const notice = firstPlainLine(row.statusNotice, 240);
    const checkout =
      plainToken(delivery?.checkout, 1024) ??
      plainToken(session?.worktreeCwd, 1024) ??
      plainToken(session?.cwd, 1024);
    out.push({
      id: row.id,
      title: titleOf(row.title),
      cli: cliOf(session?.harness),
      model: plainToken(session?.model, 80),
      status,
      statusWord: status ? statusWord(status) : null,
      notice,
      howLong: howLong(from, to),
      branch: plainToken(delivery?.branch, 200) ?? plainToken(session?.branch, 200),
      additions: countOf(session?.additions),
      deletions: countOf(session?.deletions),
      prUrl: httpsUrl(delivery?.url),
      prNumber: countOf(delivery?.number),
      checks: checksWord(checksFor(delivery, input.checks ?? [])),
      sessionId: plainToken(row.childSession, 200),
      ownerSession: plainToken(row.ownerSession, 200),
      checkout,
      actions: actionsFor(
        status,
        delivery,
        plainToken(row.childSession, 200),
        checkout,
        project,
        plainToken(row.ownerSession, 200),
      ),
    });
  }
  out.sort((a, b) => {
    const left = byId.get(a.id)?.createdAt ?? 0;
    const right = byId.get(b.id)?.createdAt ?? 0;
    return left - right || a.id.localeCompare(b.id);
  });
  return out;
}

/** A load that failed keeps what is already on screen. An empty success is real. */
export function settleLoad<T>(
  previous: T,
  outcome: { ok: true; value: T } | { ok: false },
): { value: T; stale: boolean } {
  if (outcome.ok) return { value: outcome.value, stale: false };
  return { value: previous, stale: true };
}
