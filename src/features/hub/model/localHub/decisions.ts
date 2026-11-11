// What waits on Ash and what is being built (WP-04's seam, filled by WP-14's decision store).
//
// These used to be Ash OS's ledger (needs, questions, answers, jobs, checks). The ledger is retired, so now:
// - **jobs** (Being built) are the app's own open delegations (src-tauri/src/delegations.rs), one row per delegation;
// - **needs** and **questions** are the open decisions (src-tauri/src/decisions.rs): a first mate's `ask_person`, one
//   row per stable key, answered from its "See options" sheet. Answering releases every task waiting on it. A question
//   a worker asks still goes to its own first mate first, through the delegation engine, never straight here;
// - **checks** are empty until WP-40's gates report here.
// The store and the screens read it through `DecisionSource` only.
import type { Delegation } from "../../../monos/model/delegations";
import type { Decision, FirstMateBackend } from "../../../firstmate/model/steering";
import { HubCallError } from "../hubTransport";

export interface DecisionSource {
  /** `{projects, setup, older?}` in the shape hubStore.applyNeeds reads. */
  needs(): Promise<unknown>;
  /** `{groups}` in the shape hubStore.loadJobs reads. */
  jobs(): Promise<unknown>;
  /** `{checks}` in the shape hubChecks.mapChecks reads. */
  checks(): Promise<unknown>;
  /** Ash's taps on a need, a question or a job (`need-seen`, `answer`, `job-act`, ...). */
  act(action: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Calls `fn` whenever what `needs()` or `jobs()` returns may have changed (WP-14: a decision asked or answered). */
  onChange?(fn: () => void): void;
}

const DECISION_ACTIONS = ["need-seen", "need-accept", "question", "answer", "job-options", "job-act", "job-seen", "check-delivered"] as const;
export const isDecisionAction = (action: string): boolean => (DECISION_ACTIONS as readonly string[]).includes(action);

const iso = (ms: number | null | undefined) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : "");

/** One open delegation as a Being built row. A question it asks is its owner's to answer, so it reads as waiting. */
export function delegationJob(d: Delegation): Record<string, unknown> | undefined {
  if (d.state !== "running" && d.state !== "question") return undefined;
  const title = (d.title ?? d.goal ?? d.brief ?? "").trim().split("\n")[0].slice(0, 140);
  if (!title) return undefined;
  return {
    id: d.id,
    projectId: d.project ?? "",
    title,
    lead: d.ownerMono,
    leadName: null,
    state: d.state === "question" ? "waiting" : "working",
    reason: d.state === "question" ? (d.pendingQuestion ?? "") : "",
    startedAt: iso(d.createdAt),
    lastActiveAt: iso(d.updatedAt),
    finishedAt: null,
    seen: false,
    sourceRef: `delegation:${d.rootId}`,
    ...(d.parentId ? { parentId: d.parentId } : {}),
  };
}

/** Open delegations grouped by project and owner, newest first within each group. */
export function delegationJobGroups(rows: readonly Delegation[]): { groups: Array<Record<string, unknown>> } {
  const groups = new Map<string, { leadId: string | null; leadName: string; projectId: string; jobs: Array<Record<string, unknown>> }>();
  for (const d of [...rows].sort((a, b) => b.createdAt - a.createdAt)) {
    const job = delegationJob(d);
    if (!job || !d.project) continue;
    const key = `${d.project}|${d.ownerMono ?? ""}`;
    if (!groups.has(key)) groups.set(key, { leadId: d.ownerMono, leadName: d.ownerMono ?? "Coding team", projectId: d.project, jobs: [] });
    groups.get(key)!.jobs.push(job);
  }
  return { groups: [...groups.values()] };
}

/** A decision's Needs row id: its project and key, both kept whole. */
export const decisionNeedId = (d: Pick<Decision, "project" | "decisionKey">) =>
  `decision:${encodeURIComponent(d.project)}:${encodeURIComponent(d.decisionKey)}`;

/** The decision key a Needs row id names, or undefined when it names none. */
export function needKeyOf(id: unknown): string | undefined {
  return parseNeedId(id)?.key;
}

function parseNeedId(id: unknown): { project: string; key: string } | undefined {
  if (typeof id !== "string") return undefined;
  const match = /^decision:([^:]*):([^:]+)$/.exec(id);
  if (!match) return undefined;
  try {
    return { project: decodeURIComponent(match[1]), key: decodeURIComponent(match[2]) };
  } catch {
    return undefined;
  }
}

/** One open decision as a Needs row (hubStore.mapNeed's shape): a question, answered from its sheet. */
export function decisionNeed(d: Decision): Record<string, unknown> {
  const waiting = d.waiting.length;
  const id = decisionNeedId(d);
  return {
    id,
    projectId: d.project,
    title: d.question,
    why: [d.recommended ? `Recommended: ${d.recommended}.` : "", waiting ? `${waiting} ${waiting === 1 ? "task waits" : "tasks wait"} on it.` : ""]
      .filter(Boolean)
      .join(" "),
    actionType: "see_options",
    actionLabel: "See options",
    actionTarget: `question:${id}`,
    since: iso(d.createdAt),
    circle: "red",
  };
}

/** Open decisions grouped by project, oldest first, in the shape hubStore.applyNeeds reads. */
export function decisionNeeds(decisions: readonly Decision[]): { projects: Array<Record<string, unknown>>; setup: [] } {
  const projects = new Map<string, Array<Record<string, unknown>>>();
  for (const d of decisions) {
    if (d.state !== "open") continue;
    if (!projects.has(d.project)) projects.set(d.project, []);
    projects.get(d.project)!.push(decisionNeed(d));
  }
  return { projects: [...projects].map(([projectId, shown]) => ({ projectId, shown })), setup: [] };
}

/** A decision's sheet (hubStore.question's shape). */
export function decisionSheet(d: Decision): Record<string, unknown> {
  const pick = d.recommended ? d.options.indexOf(d.recommended) : -1;
  return {
    id: decisionNeedId(d),
    questionId: d.decisionKey,
    status: d.state === "answered" ? "answered" : "open",
    question: d.question,
    options: d.options.map((label) => ({ label })),
    recommendation: { text: d.recommended ? `Recommended: ${d.recommended}` : "", optionIndex: pick >= 0 ? pick : null },
    quickAnswers: [],
    askedAt: iso(d.createdAt),
    ...(d.answer ? { heldAnswer: d.answer } : {}),
  };
}

async function findDecision(backend: Pick<FirstMateBackend, "decisions">, id: unknown): Promise<Decision> {
  const where = parseNeedId(id);
  const found = where && (await backend.decisions(100)).find((d) => d.project === where.project && d.decisionKey === where.key);
  if (!found) throw new HubCallError("refused", "That isn't waiting on you any more.");
  return found;
}

/**
 * The person's answer: an option by index, or their own words. Stored once; every task waiting on it carries on with
 * it, and the first mate that asked hears it.
 */
async function answerDecision(backend: Pick<FirstMateBackend, "decisions" | "answer">, payload: Record<string, unknown>) {
  // A Page's tap is the Page's answer, not the person's: decisions.rs refuses it on a key only the person answers. A
  // `from` that is there but blank (or not a string) is refused rather than read as the person.
  const from = typeof payload.from === "string" ? payload.from.trim() : "";
  if (payload.from !== undefined && !from) throw new HubCallError("refused", "This page has no id, so it can't answer.");
  const d = await findDecision(backend, payload.id);
  const choice = typeof payload.choice === "number" ? d.options[payload.choice] : undefined;
  const words = typeof payload.text === "string" ? payload.text.trim() : "";
  // "agree" takes the suggested answer (a Page's Take the pick); with none suggested there is nothing to take.
  const agreed = payload.quick === "agree" ? (d.recommended ?? undefined) : undefined;
  if (payload.quick === "agree" && !agreed) throw new HubCallError("refused", "No answer was suggested. Pick an option or write your answer.");
  const answer = choice ?? agreed ?? words;
  if (!answer) throw new HubCallError("refused", "Pick an option or write your answer.");
  const out = await backend.answer(d.project, d.decisionKey, answer, from ? `page:${from}` : "user");
  if (!out.applied) return { receipt: `Already answered: ${out.decision?.answer ?? ""}`, rowDone: true };
  const n = out.releasedTasks.length;
  return { receipt: n ? `Sent. ${n === 1 ? "The waiting task carries on" : `${n} waiting tasks carry on`}.` : "Sent.", rowDone: true };
}

/** The app's source: jobs from the delegation engine, and (with the store) the open decisions as Needs. */
export function delegationDecisions(
  listOpen: () => Promise<Delegation[]>,
  decisions?: Pick<FirstMateBackend, "decisions" | "answer">,
  onDecisionsChanged?: (fn: () => void) => void,
): DecisionSource {
  return {
    ...(onDecisionsChanged ? { onChange: onDecisionsChanged } : {}),
    async needs() {
      if (!decisions) return { projects: [], setup: [] };
      return decisionNeeds(await decisions.decisions(0).catch(() => []));
    },
    async jobs() {
      return delegationJobGroups(await listOpen().catch(() => []));
    },
    async checks() {
      return { checks: [] };
    },
    async act(action, payload) {
      if (action === "job-seen" || action === "check-delivered") return {};
      if (decisions && action === "question") return decisionSheet(await findDecision(decisions, payload.id));
      if (decisions && action === "answer") return answerDecision(decisions, payload);
      throw new HubCallError("refused", "That isn't waiting on you any more.");
    },
  };
}
