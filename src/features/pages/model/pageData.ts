// What a connected page reads (docs/pages-build-contract.md, "Connected pages"): the agents and what each is doing, the
// work they handed out, Being built, what waits on Ash and the rooms. Plain data in plain words, built from the same
// stores the app's own screens read (the Monos roster, the chats, the delegation rows, Waiting on you, Ash OS's jobs and
// Needs, the rooms). Pure functions: pageSources.ts feeds them and keeps a page up to date as they change.
import { DEFAULT_TEAM_IDS } from "../../hub/model/builtInMonos";
import { leadFor } from "../../hub/model/hubLeads";
import type { WaitingChat } from "../../hub/model/waitingChats";
import type { GroupChat, HubJob, HubJobGroup, HubProject, Need } from "../../hub/model/types";
import type { Delegation } from "../../monos/model/delegations";
import { failureLine, stallLine, stuckOf } from "../../monos/model/workerStuck";
import { defaultMonoName, monoState, type Mono } from "../../monos/model/mono";
import type { Session } from "../../sessions/model/session";
import { pathKey } from "../../../shared/lib/paths";
import { userLabel } from "../../hub/model/userName";

export type AgentState = "asking" | "stuck" | "working" | "paused" | "idle";
export type WorkerState = "asking" | "stuck" | "working" | "failed" | "done" | "stopped";

/** A question an agent put to Ash: `chatId` (or `needId`) is what agents.answer and agents.pick take. */
export type PageQuestion = { chatId?: string; needId?: string; text: string; pick?: string; options?: string[]; redLine: boolean; askedAt?: number; canAnswer: boolean };
/** One piece of work an agent handed out (a delegation), with the work it handed out in turn. */
export type PageWorker = {
  id: string;
  title: string;
  state: WorkerState;
  /** What it is doing now, or why it stopped. */
  doing: string;
  reason?: string;
  chatId: string;
  startedAt: number;
  /** When it got to the state it is in (best known). */
  since: number;
  endedAt?: number;
  question?: PageQuestion;
  workers: PageWorker[];
};
/** A Being built job (Ash OS), as the agent running it has it. */
export type PageJob = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  agentId: string | null;
  agentName: string;
  state: "working" | "checking" | "waiting" | "stuck" | "gave_up" | "done" | "parked" | "unknown";
  reason?: string;
  startedAt?: number;
  lastActiveAt?: number;
  finishedAt?: number;
};
export type PageAgent = {
  id: string;
  name: string;
  role: "lead" | "team" | "mono";
  projects: string[];
  state: AgentState;
  /** What it is doing now, plain words ("" when idle). */
  doing: string;
  reason?: string;
  /** When it got to the state it is in (best known, ms). */
  since: number;
  /** Its own chat (absent until it was first opened). */
  chatId?: string;
  question?: PageQuestion;
  workers: PageWorker[];
  jobs: PageJob[];
  /** How many of its workers are still at it. */
  waitingOn: number;
};
export type AgentsData = { agents: PageAgent[]; counts: Record<AgentState, number> };

// Stuck has one definition everywhere (monos/model/workerStuck.ts): a worker asking, stalled (the app's watcher marks
// its row quiet, loop or idle: workerStall.ts) or failed. The page reads it from the delegation rows like every screen.
const MAX_DEPTH = 4;
const MAX_WORKERS = 20;

export type AgentInputs = {
  monos: readonly Mono[];
  session(id: string): Session | undefined;
  rows: readonly Delegation[];
  waiting: readonly WaitingChat[];
  jobs: readonly HubJobGroup[];
  projects: readonly HubProject[];
  /** How long a chat has been as it is now (ms), when known: no new word, or not busy (for `since`). */
  quietFor(sessionId: string): number | undefined;
  now: number;
};

const isoMs = (iso: string | null | undefined) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? undefined : t;
};

export function agentName(mono: Pick<Mono, "id" | "name" | "mascot">): string {
  return mono.name?.trim() || leadFor(mono.id)?.name || defaultMonoName(mono.mascot);
}

function projectsOf(mono: Mono, projects: readonly HubProject[]): string[] {
  const lead = leadFor(mono.id);
  if (lead) return [lead.projectId];
  const keys = new Set(mono.projects.map(pathKey));
  return projects.filter((p) => p.folder && keys.has(pathKey(p.folder))).map((p) => p.id);
}

function liveQuestion(session: Session | undefined): { text: string; options: string[] } | undefined {
  const q = session?.pendingQuestion;
  const first = q?.questions[0];
  if (!q || !first) return undefined;
  return { text: (q.title?.trim() || first.prompt).trim(), options: first.options.map((o) => o.label) };
}

function jobOf(job: HubJob, group: HubJobGroup, projects: readonly HubProject[]): PageJob {
  const state: PageJob["state"] =
    job.state === "sent_to_lead" ? "stuck" : job.state === "lead_gave_up" ? "gave_up" : job.state;
  return {
    id: job.id,
    projectId: job.projectId,
    projectName: projects.find((p) => p.id === job.projectId)?.name ?? job.projectId,
    title: job.title,
    agentId: group.leadId,
    agentName: group.leadName,
    state,
    ...(job.reason && (state === "stuck" || state === "gave_up") ? { reason: job.reason } : {}),
    ...(isoMs(job.startedAt) !== undefined ? { startedAt: isoMs(job.startedAt) } : {}),
    ...(isoMs(job.lastActiveAt) !== undefined ? { lastActiveAt: isoMs(job.lastActiveAt) } : {}),
    ...(isoMs(job.finishedAt) !== undefined ? { finishedAt: isoMs(job.finishedAt) } : {}),
  };
}

/** Every Being built job, with its project's and agent's names. */
export function jobsData(groups: readonly HubJobGroup[], projects: readonly HubProject[]): { jobs: PageJob[] } {
  return { jobs: groups.flatMap((g) => g.jobs.map((j) => jobOf(j, g, projects))) };
}

const ROW_STATE: Record<Delegation["state"], WorkerState> = { running: "working", question: "asking", completed: "done", failed: "failed", cancelled: "stopped" };

/** "Usage limit reached, resets 3:10pm": why a worker failed, as every surface says it (workerStuck.ts). */
function failedWords(row: Delegation): string {
  const words = failureLine(row).replace(/^Failed: /, "");
  return words[0].toUpperCase() + words.slice(1);
}

/** Where one piece of handed-out work stands, from its row (the one reading of stuck) and, when loaded, its chat. */
export function workerState(row: Delegation, session: Session | undefined, now: number): Pick<PageWorker, "state" | "doing" | "reason"> {
  const base = ROW_STATE[row.state];
  if (base === "failed") return { state: "failed", doing: "Failed", reason: failedWords(row) };
  if (base === "stopped") return { state: "stopped", doing: "Stopped", ...(row.error ? { reason: row.error } : {}) };
  if (base === "done") return { state: "done", doing: "Done" };
  const live = liveQuestion(session);
  if (base === "asking" || live) return { state: "asking", doing: "Asking" };
  if (stuckOf(row, now)?.kind === "stalled")
    return {
      state: "stuck",
      doing: row.stallKind === "idle" ? "Stopped" : session ? (monoState(session).activity ?? "Working") : "Working",
      reason: stallLine(row, now),
    };
  return { state: "working", doing: session ? monoState(session).activity ?? "Working" : "Working" };
}

function questionFor(chatId: string, session: Session | undefined, waiting: readonly WaitingChat[], row?: Delegation): PageQuestion | undefined {
  const w = waiting.find((c) => c.sessionId === chatId);
  if (w) return { chatId, text: w.question, ...(w.pick ? { pick: w.pick } : {}), redLine: w.redLine, askedAt: w.askedAt, canAnswer: true };
  const live = liveQuestion(session);
  if (live) {
    const rec = session?.pendingQuestion?.questions[0]?.options.find((o) => /recommended/i.test(o.label) || /^\s*recommended\b/i.test(o.description ?? ""));
    return { chatId, text: live.text, options: live.options, ...(rec ? { pick: rec.label.replace(/\s*[([]\s*recommended\s*[)\]]\s*/i, " ").trim() } : {}), redLine: false, canAnswer: true };
  }
  if (row?.pendingQuestion) return { chatId, text: row.pendingQuestion, redLine: false, canAnswer: false };
  return undefined;
}

function workersUnder(owner: string, inputs: AgentInputs, depth: number, seen: Set<string>): PageWorker[] {
  if (depth > MAX_DEPTH) return [];
  // The newest row per chat: a chat that was briefed again shows once, as it is now.
  const latest = new Map<string, Delegation>();
  for (const row of inputs.rows) {
    if (row.ownerSession !== owner || seen.has(row.id)) continue;
    const known = latest.get(row.childSession);
    if (!known || row.createdAt > known.createdAt) latest.set(row.childSession, row);
  }
  const rows = [...latest.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_WORKERS);
  return rows.map((row) => {
    seen.add(row.id);
    const session = inputs.session(row.childSession);
    const st = workerState(row, session, inputs.now);
    const question = st.state === "asking" ? questionFor(row.childSession, session, inputs.waiting, row) : undefined;
    const ended = row.settledAt ?? undefined;
    return {
      id: row.id,
      title: row.title?.trim() || "Delegated work",
      ...st,
      chatId: row.childSession,
      startedAt: row.createdAt,
      since: st.state === "stuck" ? (row.stalledAt ?? row.updatedAt) : ended ?? row.updatedAt,
      ...(ended ? { endedAt: ended } : {}),
      ...(question ? { question } : {}),
      workers: workersUnder(row.childSession, inputs, depth + 1, seen),
    };
  });
}

const RANK: Record<PageAgent["role"], number> = { team: 0, lead: 1, mono: 2 };

/** Every seated agent (the Monos roster: the team, the Leads, any Mono Ash added) and what each is doing now. */
export function agentsData(inputs: AgentInputs): AgentsData {
  const counts: Record<AgentState, number> = { asking: 0, stuck: 0, working: 0, paused: 0, idle: 0 };
  const agents = inputs.monos.map((mono): PageAgent => {
    const role: PageAgent["role"] = leadFor(mono.id) ? "lead" : DEFAULT_TEAM_IDS.includes(mono.id) ? "team" : "mono";
    const chatId = mono.sessionId;
    const session = chatId ? inputs.session(chatId) : undefined;
    const quiet = chatId ? inputs.quietFor(chatId) : undefined;
    const workers = chatId ? workersUnder(chatId, inputs, 1, new Set()) : [];
    const waitingOn = workers.filter((w) => w.state === "working" || w.state === "asking" || w.state === "stuck").length;
    const jobs = inputs.jobs.filter((g) => g.leadId === mono.id).flatMap((g) => g.jobs.map((j) => jobOf(j, g, inputs.projects)));
    const question = chatId ? questionFor(chatId, session, inputs.waiting) : undefined;
    let state: AgentState = "idle";
    let doing = "";
    let reason: string | undefined;
    let since = inputs.now - (quiet ?? 0);
    const look = session ? monoState(session) : undefined;
    if (question) {
      state = "asking";
      doing = "Asking you";
      since = question.askedAt ?? since;
    } else if (look?.status === "needs-you") {
      // An approval waits in its chat (Open it), or it stopped on a usage limit or after restarts.
      const approval = /^Approve |Waiting for approval/.test(look.activity ?? "");
      state = approval ? "asking" : "stuck";
      doing = look.activity ?? "Needs you";
      if (approval) {
        const q: PageQuestion = { ...(chatId ? { chatId } : {}), text: look.activity ?? "It waits for your approval.", redLine: false, canAnswer: false };
        return finish({ state, doing, question: q });
      }
      reason = look.activity;
    } else if (look?.status === "failed") {
      // Its last turn failed (out of credits, overloaded): it can't answer, with the plain reason.
      state = "stuck";
      doing = "Can't answer";
      reason = look.activity;
    } else if (look?.status === "paused") {
      state = "paused";
      doing = look.activity ?? "Paused";
    } else if (look?.status === "working") {
      // Its own chat is stuck only when the app's watcher marked the brief it works on stalled (a Lead briefed by the
      // leadership team), like any worker's.
      const own = chatId ? inputs.rows.find((r) => r.childSession === chatId && r.state === "running" && r.stallKind) : undefined;
      state = own ? "stuck" : "working";
      doing = look.activity ?? "Working";
      if (own) {
        reason = stallLine(own, inputs.now);
        since = own.stalledAt ?? since;
      }
    } else if (waitingOn) {
      state = "working";
      doing = `Waiting on ${waitingOn} ${waitingOn === 1 ? "worker" : "workers"}`;
    }
    const stuckJob = jobs.find((j) => j.state === "stuck" || j.state === "gave_up");
    if (stuckJob && (state === "working" || state === "idle")) {
      state = "stuck";
      reason = `${stuckJob.title}: ${stuckJob.reason ?? (stuckJob.state === "gave_up" ? "stuck, needs you" : "stuck")}`;
      doing = doing || stuckJob.title;
      since = stuckJob.lastActiveAt ?? since;
    } else if (state === "idle") {
      const busyJob = jobs.find((j) => j.state === "working" || j.state === "checking");
      if (busyJob) {
        state = "working";
        doing = busyJob.title;
      }
    }
    return finish({ state, doing, ...(reason ? { reason } : {}) });

    function finish(st: { state: AgentState; doing: string; reason?: string; question?: PageQuestion }): PageAgent {
      counts[st.state] += 1;
      return {
        id: mono.id,
        name: agentName(mono),
        role,
        projects: projectsOf(mono, inputs.projects),
        state: st.state,
        doing: st.doing,
        ...(st.reason ? { reason: st.reason } : {}),
        since,
        ...(chatId ? { chatId } : {}),
        ...(st.question ?? question ? { question: st.question ?? question } : {}),
        workers,
        jobs,
        waitingOn,
      };
    }
  });
  agents.sort((a, b) => RANK[a.role] - RANK[b.role]);
  return { agents, counts };
}

/** What waits on Ash: Ash OS's Needs and the chats whose agent asked him something. */
export function needsData(needs: readonly Need[], waiting: readonly WaitingChat[], projects: readonly HubProject[]) {
  const name = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name ?? id : null);
  return {
    needs: needs
      .filter((n) => n.state !== "done")
      .map((n) => ({
        id: n.id,
        projectId: n.projectId,
        projectName: name(n.projectId),
        title: n.title,
        why: n.why,
        action: n.actionLabel,
        /** A question from Ash OS: agents.answer and agents.pick take this id as needId. */
        isQuestion: n.id.startsWith("q:") || n.actionType === "see_options",
        ...(n.since ? { since: isoMs(n.since) } : {}),
      })),
    waiting: waiting.map((c) => ({
      chatId: c.sessionId,
      chatName: c.chatName,
      projectId: c.projectId,
      projectName: c.projectName,
      agentId: c.monoId ?? null,
      question: c.question,
      ...(c.pick ? { pick: c.pick } : {}),
      redLine: c.redLine,
      askedAt: c.askedAt,
    })),
  };
}

/** The rooms (group chats): their latest conversation's last messages, oldest first. `projectId` keeps one project's. */
export function roomsData(chats: readonly GroupChat[], nameOf: (monoId: string) => string, args: { projectId?: unknown; limit?: unknown } = {}) {
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(100, Math.floor(args.limit)) : 30;
  const pid = typeof args.projectId === "string" && args.projectId ? args.projectId : undefined;
  return {
    rooms: chats
      .filter((c) => !pid || c.projectId === pid)
      .map((c) => {
        const conv = c.conversations[c.conversations.length - 1];
        return {
          id: c.id,
          projectId: c.projectId,
          name: c.name,
          members: c.memberIds.map(nameOf),
          ...(c.replyPending ? { typing: nameOf(c.replyPending) } : {}),
          conversation: conv
            ? {
                id: conv.id,
                title: conv.title,
                when: conv.when,
                messages: conv.messages.slice(-limit).map((m) => ({ id: m.id, from: m.from === "ash" ? userLabel() : nameOf(m.from), text: m.text })),
              }
            : null,
        };
      }),
  };
}
