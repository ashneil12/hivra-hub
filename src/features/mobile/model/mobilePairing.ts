// Hivra WP-150: a paired phone reads the Inbox and the crew, and approves or denies one tool call.
// The desktop approval path is the only one that answers. Nothing here defaults to allow.

import { invoke } from "@tauri-apps/api/core";
import { waitingPhrase, inboxItems, type DecisionInput, type FirstMateInboxKind } from "../../crew/model/inbox";
import {
  crewRows,
  type CrewChecksInput,
  type CrewDeliveryInput,
  type CrewRow,
  type CrewSessionInput,
  type CrewWorkerInput,
} from "../../crew/model/rows";
import { tauriFirstMate, type Decision } from "../../firstmate/model/steering";
import { loadCrewDelegations } from "../../crew/model/load";
import { tauriPrWatches, type PrWatch } from "../../pr-watch/model/prWatches";
import { sameProjectPath } from "../../projects/model/recents";
import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { Block, Session } from "../../sessions/model/session";

/** Same encoding as the workspace poll's project id. */
export function mobileProjectKey(path: string): string {
  return encodeURIComponent(path);
}

const MAX_APPROVALS = 64;
const MAX_PROJECTS = 64;
const MAX_COMMAND = 16_000;
const MAX_TOOL = 200;
const MAX_PATH = 1024;
const MAX_PATHS = 64;

export type PublishedApproval = {
  conversationId: string;
  requestId: number;
  /** The block that carries this call. Unique for good, unlike a session's request ids. */
  blockId: string;
  tool: string;
  /** The provider's command, unchanged. Null when the tool has none. Matching uses this, never `display`. */
  command: string | null;
  paths: string[];
  /** What the phone shows: the command (or paths) with carriage returns and hidden characters escaped. */
  display: string;
  project: string;
  at: number;
};

export type LiveApprovals = {
  rows: PublishedApproval[];
  /** More calls were waiting than a phone can safely show. Nothing is published. */
  truncated: boolean;
};

export type InboxLine = {
  id: string;
  kind: FirstMateInboxKind | "approval";
  title: string;
  body: string;
  waiting: string | null;
  conversationId: string | null;
  projectId: string;
  requestId?: number;
  tool?: string;
  command?: string | null;
  paths?: string[];
  options?: string[];
  recommended?: string | null;
};

export type PhoneCrewWorker = {
  id: string;
  projectId: string;
  title: string;
  status: CrewRow["status"];
  statusWord: string | null;
  notice: string | null;
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  checks: string | null;
  sessionId: string | null;
  ownerSession: string | null;
  howLong: string;
};

type Load<T> = { ok: true; value: T } | { ok: false };

export type PairingSources = {
  loadCrew: () => Promise<Load<readonly CrewWorkerInput[]>>;
  loadDecisions: () => Promise<Load<readonly DecisionInput[]>>;
  loadDeliveries: (project: string) => Promise<Load<readonly CrewDeliveryInput[]>>;
  loadChecks: () => Promise<Load<readonly CrewChecksInput[]>>;
};

export type PairingContext = {
  sessions: readonly Session[];
  now: number;
  /**
   * Sends the decision to the window's live call. Returns false when the window could not
   * take it (the call is gone or the session is not reachable); the phone is then refused
   * and the call stays answerable. Nothing here says "done" for a decision not sent.
   */
  approve: (sessionId: string, requestId: number, decision: ApprovalDecision) => boolean;
  /** A remote session whose desktop tab is not open cannot take the decision. */
  remoteBlocked: (session: Session) => boolean;
  sources?: PairingSources;
  /** Remembers a decision so a second call cannot allow it again. */
  answered?: Set<string>;
  /**
   * The calls the phone may show and answer: the same filtered rows the catalog publishes.
   * Both the inbox and approve/deny match only these. Without it nothing is shown and
   * nothing is answered (fail closed).
   */
  approvals?: (sessions: readonly Session[]) => LiveApprovals;
  /**
   * Chats the phone must never see: a private chat (WP-111), saved or live. Their questions and
   * crew rows are left out of the inbox and crew status. Without it nothing is left out.
   */
  privateIds?: ReadonlySet<string>;
};

const sharedAnswered = new Set<string>();

const NO_APPROVALS: (sessions: readonly Session[]) => LiveApprovals = () => ({ rows: [], truncated: false });

/** Test hook. The desktop process keeps the real set for the life of the window. */
export function clearMobileApprovals(): void {
  sharedAnswered.clear();
}

function cleanProject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.replace(/\r/g, "").trim();
  if (!path || path === "~" || path.includes("\0")) return null;
  return path;
}

function approvable(session: Session): boolean {
  if (!session.id || session.id.length > 256 || session.id.includes("\0")) return false;
  if (session.worktreeRemoved || session.busy === false) return false;
  if (session.orchestrationLeadId || session.inboxAsk || session.sidebarHidden) return false;
  // WP-111: a private chat's command and paths never leave the desktop.
  if (session.private === true) return false;
  return cleanProject(session.cwd) != null;
}

/**
 * Escapes what a person could not see in a command: carriage returns, control characters, and bidi
 * or zero-width characters. Newlines and tabs stay. The exact text is kept for matching elsewhere.
 */
export function escapeForDisplay(text: string): string {
  return text.replace(
    /\r|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g,
    (character) =>
      character === "\r" ? "\\r" : `\\u{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

function approvalOf(session: Session, block: Block): PublishedApproval | null {
  const approval = block.approval;
  const call = approval?.call;
  const requestId = approval?.requestId;
  if (!approval || approval.decided) return null;
  // WP-150 H1: only a Bash call the desktop marked complete is shown. Its arguments are all the
  // phone can see, so an allow runs exactly what it showed. Any other tool (MCP, WebFetch, Write,
  // Edit, Task) or a Bash call with a sandbox override is never published.
  if (approval.callComplete !== true || call?.tool !== "Bash") return null;
  // A session's request ids start again at 1 with each harness process. Without
  // the block's own id the answered set cannot tell a new call that reuses one
  // from the call already decided.
  if (typeof block.id !== "string" || !block.id || block.id.length > 256) return null;
  if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId < 0) return null;
  const tool = call?.tool;
  if (typeof tool !== "string" || !tool.trim() || tool.length > MAX_TOOL || tool.includes("\0")) return null;
  let command: string | null = null;
  if (typeof call?.command === "string") {
    if (call.command.length > MAX_COMMAND || call.command.includes("\0")) return null;
    command = call.command.length > 0 ? call.command : null;
  }
  const paths: string[] = [];
  if (call?.paths != null) {
    if (!Array.isArray(call.paths) || call.paths.length > MAX_PATHS) return null;
    for (const path of call.paths) {
      if (typeof path !== "string" || path.length > MAX_PATH || path.includes("\0")) return null;
      paths.push(path);
    }
  }
  const project = cleanProject(session.cwd);
  if (!project) return null;
  const started = block.tool?.startedAt ?? block.startedAt ?? 0;
  return {
    conversationId: session.id,
    requestId,
    blockId: block.id,
    tool,
    command,
    paths,
    display: escapeForDisplay(command ?? paths.join("\n")),
    project,
    at: typeof started === "number" && Number.isFinite(started) ? started : 0,
  };
}

/** Undecided tool calls the phone may show. A duplicate id, or too many, publishes nothing for that id. */
export function liveApprovals(sessions: readonly Session[]): LiveApprovals {
  const rows: PublishedApproval[] = [];
  for (const session of sessions) {
    if (!approvable(session)) continue;
    const seen = new Map<number, PublishedApproval | null>();
    for (const block of session.blocks) {
      if (!block.approval || block.approval.decided) continue;
      const requestId = block.approval.requestId;
      if (typeof requestId !== "number" || !Number.isSafeInteger(requestId)) continue;
      if (seen.has(requestId)) {
        seen.set(requestId, null);
        continue;
      }
      seen.set(requestId, approvalOf(session, block));
    }
    for (const row of seen.values()) if (row) rows.push(row);
  }
  rows.sort((a, b) => a.conversationId.localeCompare(b.conversationId) || a.requestId - b.requestId);
  if (rows.length > MAX_APPROVALS) return { rows: [], truncated: true };
  return { rows, truncated: false };
}

/**
 * Calls the phone may approve: a listed chat, or a Mono's own one-to-one chat.
 * A Mono's chat stays off the session list. A call from neither is not published.
 * A room conversation runs in a session of its own, and answering one there goes
 * through the Mono's habit/hidden-run path, not the direct approval the phone
 * calls, so those are left out: better no answer than a "done" for a tool that
 * never ran.
 */
export function publishedApprovals(
  sessions: readonly Session[],
  listedSessionIds: ReadonlySet<string>,
  monoSessionIds: ReadonlySet<string>,
  roomSessionIds: ReadonlySet<string> = new Set(),
): LiveApprovals {
  const live = liveApprovals(sessions);
  if (live.truncated) return live;
  return {
    rows: live.rows.filter(
      (row) =>
        !roomSessionIds.has(row.conversationId) &&
        (listedSessionIds.has(row.conversationId) || monoSessionIds.has(row.conversationId)),
    ),
    truncated: false,
  };
}

function samePaths(echo: unknown, stored: readonly string[]): boolean {
  if (echo === undefined) return stored.length === 0;
  if (!Array.isArray(echo) || echo.length !== stored.length) return false;
  return echo.every((item, index) => item === stored[index]);
}

function blanket(params: Record<string, unknown>): boolean {
  for (const key of ["all", "scope", "approveAll", "allowAll"]) {
    if (key in params && params[key] != null) return true;
  }
  return params.decision === "allow_all" || params.decision === "allow-all" || params.decision === "all";
}

function expectedDecision(method: string): ApprovalDecision | null {
  if (method === "session.approve") return "allow";
  if (method === "session.deny") return "deny";
  return null;
}

const RANK: Record<InboxLine["kind"], number> = {
  decision: 0,
  question: 0,
  credential: 1,
  approval: 1,
  failure: 2,
  review: 2,
};

function waitKey(value: number): number {
  return value > 0 && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Waiting lines for the projects named. Read only. An empty project list is an empty inbox. */
export function inboxLines(input: {
  projects: readonly string[];
  decisions: readonly DecisionInput[];
  rows: readonly CrewWorkerInput[];
  deliveries: readonly CrewDeliveryInput[];
  approvals: readonly PublishedApproval[];
  now: number;
}): InboxLine[] {
  const lines: InboxLine[] = [];
  for (const project of input.projects) {
    const cleaned = cleanProject(project);
    if (!cleaned) continue;
    for (const item of inboxItems({
      project: cleaned,
      decisions: input.decisions,
      rows: input.rows,
      deliveries: input.deliveries,
    })) {
      lines.push({
        id: item.id,
        kind: item.kind,
        title: item.title,
        body: item.body,
        waiting: waitingPhrase(item.updatedAt, input.now),
        conversationId: item.chatId,
        projectId: mobileProjectKey(cleaned),
        ...(item.options.length ? { options: item.options, recommended: item.recommended } : {}),
      });
    }
    for (const approval of input.approvals) {
      if (!sameProjectPath(approval.project, cleaned)) continue;
      lines.push({
        id: `approval:${approval.conversationId}:${approval.requestId}`,
        kind: "approval",
        title: escapeForDisplay(approval.tool),
        body: approval.display,
        waiting: waitingPhrase(approval.at, input.now),
        conversationId: approval.conversationId,
        projectId: mobileProjectKey(cleaned),
        requestId: approval.requestId,
        tool: approval.tool,
        command: approval.command,
        paths: approval.paths,
      });
    }
  }
  // Longest wait first within a group. The phrase is not a timestamp, so sort by the source time.
  lines.sort((a, b) => {
    const rank = RANK[a.kind] - RANK[b.kind];
    if (rank !== 0) return rank;
    const left = timeOf(a, input);
    const right = timeOf(b, input);
    return waitKey(left) - waitKey(right) || a.id.localeCompare(b.id);
  });
  return lines;
}

function timeOf(
  line: InboxLine,
  input: { decisions: readonly DecisionInput[]; rows: readonly CrewWorkerInput[]; approvals: readonly PublishedApproval[] },
): number {
  if (line.kind === "approval") {
    return input.approvals.find((row) => row.conversationId === line.conversationId && row.requestId === line.requestId)?.at ?? 0;
  }
  const decision = input.decisions.find((row) => line.id === `decision:${cleanProject(row.project) ?? ""}:${row.decisionKey}`);
  if (decision?.updatedAt) return decision.updatedAt;
  const row = input.rows.find((item) => line.id.endsWith(`:${item.id}`));
  return row?.updatedAt ?? 0;
}

/** Crew rows with nothing the phone could use to change them. */
export function crewStatus(input: {
  projects: readonly string[];
  rows: readonly CrewWorkerInput[];
  sessions?: readonly CrewSessionInput[];
  deliveries?: readonly CrewDeliveryInput[];
  checks?: readonly CrewChecksInput[];
  now: number;
}): { workers: PhoneCrewWorker[] } {
  const workers: PhoneCrewWorker[] = [];
  for (const project of input.projects) {
    const cleaned = cleanProject(project);
    if (!cleaned) continue;
    for (const row of crewRows({
      project: cleaned,
      rows: input.rows,
      sessions: input.sessions,
      deliveries: input.deliveries,
      checks: input.checks,
      now: input.now,
    })) {
      workers.push({
        id: row.id,
        projectId: mobileProjectKey(cleaned),
        title: row.title,
        status: row.status,
        statusWord: row.statusWord,
        notice: row.notice,
        branch: row.branch,
        prUrl: row.prUrl,
        prNumber: row.prNumber,
        checks: row.checks,
        sessionId: row.sessionId,
        ownerSession: row.ownerSession,
        howLong: row.howLong,
      });
    }
  }
  return { workers };
}

function pathFromProjectId(projectId: string): string {
  if (typeof projectId !== "string" || projectId.length > 4096) {
    throw new Error("Project is no longer available.");
  }
  let path: string;
  try {
    path = decodeURIComponent(projectId);
  } catch {
    throw new Error("Project is no longer available.");
  }
  const cleaned = cleanProject(path);
  if (!cleaned) throw new Error("Project is no longer available.");
  return cleaned;
}

function projectsOf(
  params: Record<string, unknown>,
  decisions: readonly DecisionInput[],
  rows: readonly CrewWorkerInput[],
  sessions: readonly Session[],
): string[] {
  if (typeof params.projectId === "string") return [pathFromProjectId(params.projectId)];
  if ("projectId" in params && params.projectId != null) throw new Error("Project is no longer available.");
  const found = new Set<string>();
  for (const decision of decisions) {
    const project = cleanProject(decision.project);
    if (project) found.add(project);
  }
  for (const row of rows) {
    const project = cleanProject(row.project);
    if (project) found.add(project);
  }
  for (const session of sessions) {
    const project = cleanProject(session.cwd);
    if (project) found.add(project);
  }
  const projects = [...found].sort();
  if (projects.length > MAX_PROJECTS) throw new Error("Too many projects to list from the phone.");
  return projects;
}

function asWorker(value: unknown): CrewWorkerInput | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim() || row.id.includes("\0")) return null;
  const project = typeof row.project === "string" && !row.project.includes("\0") ? row.project : null;
  return {
    id: row.id,
    project,
    title: typeof row.title === "string" ? row.title : null,
    status: row.status,
    statusNotice: typeof row.statusNotice === "string" ? row.statusNotice : null,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : undefined,
    settledAt: typeof row.settledAt === "number" ? row.settledAt : null,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : undefined,
    childSession: typeof row.childSession === "string" ? row.childSession : null,
    parentId: typeof row.parentId === "string" ? row.parentId : null,
    ownerSession: typeof row.ownerSession === "string" ? row.ownerSession : null,
    errorClass: typeof row.errorClass === "string" ? row.errorClass : null,
    error: typeof row.error === "string" ? row.error : null,
    follow: typeof row.follow === "string" ? row.follow : null,
  };
}

function asDecision(value: unknown): DecisionInput | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Decision;
  if (typeof row.decisionKey !== "string" || !row.decisionKey.trim()) return null;
  return {
    project: typeof row.project === "string" ? row.project : null,
    decisionKey: row.decisionKey,
    question: typeof row.question === "string" ? row.question : null,
    options: Array.isArray(row.options) ? row.options : [],
    recommended: typeof row.recommended === "string" ? row.recommended : null,
    askedBy: typeof row.askedBy === "string" ? row.askedBy : null,
    waiting: Array.isArray(row.waiting) ? row.waiting : [],
    state: row.state === "answered" ? "answered" : "open",
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
  };
}

function asDelivery(value: unknown): CrewDeliveryInput | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return {
    delegationId: typeof row.delegationId === "string" ? row.delegationId : null,
    state: typeof row.state === "string" ? row.state : null,
    url: typeof row.url === "string" ? row.url : null,
    number: typeof row.number === "number" ? row.number : null,
    branch: typeof row.branch === "string" ? row.branch : null,
    checkout: typeof row.checkout === "string" ? row.checkout : null,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
  };
}

function asChecks(watch: PrWatch): CrewChecksInput {
  const status = watch.status;
  return {
    number: watch.number,
    url: watch.url,
    repo: watch.repo,
    passed: status?.passed === true,
    pending: status?.pending,
    failed: Array.isArray(status?.failed) ? status.failed : [],
    checks: status?.checks,
  };
}

function listOrFail<T>(value: unknown, map: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const mapped = map(item);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** One read of the stores. A later read must not replace this snapshot. */
async function readSnapshot(sources: PairingSources, crew: boolean): Promise<{
  rows: readonly CrewWorkerInput[];
  decisions: readonly DecisionInput[];
  checks: readonly CrewChecksInput[];
}> {
  const [listed, asked, watches] = await Promise.all([
    sources.loadCrew(),
    crew ? Promise.resolve({ ok: true as const, value: [] as readonly DecisionInput[] }) : sources.loadDecisions(),
    crew ? sources.loadChecks() : Promise.resolve({ ok: true as const, value: [] as readonly CrewChecksInput[] }),
  ]);
  if (!listed.ok || !asked.ok || !watches.ok) {
    throw new Error(crew ? "Crew status could not be read. Try again." : "Inbox could not be read. Try again.");
  }
  return { rows: listed.value, decisions: asked.value, checks: watches.value };
}

async function readDeliveries(
  sources: PairingSources,
  projects: readonly string[],
  crew: boolean,
): Promise<CrewDeliveryInput[]> {
  const deliveries: CrewDeliveryInput[] = [];
  for (const project of projects) {
    const loaded = await sources.loadDeliveries(project);
    if (!loaded.ok) {
      throw new Error(crew ? "Crew status could not be read. Try again." : "Inbox could not be read. Try again.");
    }
    deliveries.push(...loaded.value);
  }
  return deliveries;
}

function defaultSources(): PairingSources {
  return {
    loadCrew: async () => {
      const loaded = await loadCrewDelegations();
      if (!loaded.ok) return { ok: false };
      const value = listOrFail(loaded.value, asWorker);
      return value ? { ok: true, value } : { ok: false };
    },
    loadDecisions: async () => {
      try {
        const listed = await tauriFirstMate.decisions();
        const value = listOrFail(listed, asDecision);
        return value ? { ok: true, value } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
    loadDeliveries: async (project) => {
      try {
        const listed = await invoke("delivery_list", { project });
        const value = listOrFail(listed, asDelivery);
        return value ? { ok: true, value } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
    loadChecks: async () => {
      try {
        const listed = await tauriPrWatches.list();
        if (!Array.isArray(listed)) return { ok: false };
        return { ok: true, value: listed.map(asChecks) };
      } catch {
        return { ok: false };
      }
    },
  };
}

async function decide(method: string, params: Record<string, unknown>, ctx: PairingContext): Promise<unknown> {
  if (blanket(params)) throw new Error("One tool call at a time.");
  const decision = expectedDecision(method);
  if (!decision) throw new Error("Unsupported mobile command");
  if ("decision" in params && params.decision != null && params.decision !== decision) {
    throw new Error("This approval does not match a waiting tool call.");
  }
  const requestId = params.requestId;
  if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId < 0) {
    throw new Error("Missing approval request.");
  }
  const conversationId = params.conversationId;
  if (typeof conversationId !== "string" || !conversationId || conversationId.length > 256 || conversationId.includes("\0")) {
    throw new Error("This approval does not match a waiting tool call.");
  }
  const pending = (ctx.approvals ?? NO_APPROVALS)(ctx.sessions);
  if (pending.truncated) throw new Error("Too many approvals to list from the phone.");
  const matches = pending.rows.filter((row) => row.conversationId === conversationId && row.requestId === requestId);
  if (matches.length !== 1) throw new Error("This approval does not match a waiting tool call.");
  const call = matches[0];
  const command = params.command === undefined || params.command === null ? null : params.command;
  if ((command !== null && typeof command !== "string") || command !== call.command || params.tool !== call.tool || !samePaths(params.paths, call.paths)) {
    throw new Error("The command does not match.");
  }
  const book = ctx.answered ?? sharedAnswered;
  // The block id, not the request id: request ids restart at 1 with each run, so
  // keying on them would refuse a new call that happened to reuse one.
  const key = `${conversationId}\0${call.blockId}`;
  if (book.has(key)) throw new Error("This approval was already answered.");
  const session = ctx.sessions.find((item) => item.id === conversationId);
  if (!session || ctx.remoteBlocked(session)) throw new Error("Open this session on the desktop to answer it.");
  // Only a confirmed take is recorded. A window that could not send it (or sent nothing) is a refusal.
  if (ctx.approve(session.id, requestId, decision) !== true) {
    throw new Error("Could not send this decision to the desktop. Try again.");
  }
  book.add(key);
  return {
    requestId,
    decision,
    tool: call.tool,
    command: call.command,
    paths: call.paths,
  };
}

/**
 * Inbox, crew status, or one tool decision. A store that cannot be read is a retry, not an empty list.
 * Approve and deny call `ctx.approve` only after the live call matches.
 */
export async function runMobilePairing(
  method: string,
  params: Record<string, unknown>,
  ctx: PairingContext,
): Promise<unknown> {
  if (method === "session.approve" || method === "session.deny") return decide(method, params, ctx);
  if (method !== "inbox.list" && method !== "crew.status") throw new Error("Unsupported mobile command");
  const sources = ctx.sources ?? defaultSources();
  const crew = method === "crew.status";
  const snapshot = await readSnapshot(sources, crew);
  // WP-111: a private chat's question and crew row never reach the phone.
  const hidden = ctx.privateIds ?? new Set<string>();
  const loaded = {
    decisions: snapshot.decisions.filter((decision) => !hidden.has((decision.askedBy ?? "").trim())),
    rows: snapshot.rows.filter(
      (row) => !(row.childSession && hidden.has(row.childSession)) && !(row.ownerSession && hidden.has(row.ownerSession)),
    ),
    checks: snapshot.checks,
  };
  const pending = (ctx.approvals ?? NO_APPROVALS)(ctx.sessions);
  if (!crew && pending.truncated) throw new Error("Too many approvals to list from the phone.");
  let projects: string[];
  try {
    projects = projectsOf(params, loaded.decisions, loaded.rows, ctx.sessions);
  } catch (error) {
    if (error instanceof Error && error.message === "Too many projects to list from the phone.") throw error;
    if (error instanceof Error && error.message === "Project is no longer available.") throw error;
    throw new Error("Project is no longer available.");
  }
  const deliveries = await readDeliveries(sources, projects, crew);
  if (crew) {
    return crewStatus({
      projects,
      rows: loaded.rows,
      sessions: ctx.sessions.map((session) => ({
        id: session.id,
        harness: session.harness,
        model: session.model,
        branch: session.branch ?? null,
        cwd: session.cwd,
        worktreeCwd: session.worktreeCwd ?? null,
      })),
      deliveries,
      checks: loaded.checks,
      now: ctx.now,
    });
  }
  return {
    lines: inboxLines({
      projects,
      decisions: loaded.decisions,
      rows: loaded.rows,
      deliveries,
      approvals: pending.rows,
      now: ctx.now,
    }),
  };
}
