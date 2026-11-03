// What waits on Ash and what is being built (WP-04's seam for WP-14's decision store).
//
// These used to be Ash OS's ledger (needs, questions, answers, jobs, checks). The ledger is retired, so for now:
// - **jobs** (Being built) are the app's own open delegations (src-tauri/src/delegations.rs), one row per delegation;
// - **needs**, **questions** and **checks** are empty: nothing outside the app asks Ash anything any more. A question
//   a worker asks still reaches its owner's chat through the delegation engine, as before.
// WP-14 replaces this source with the decision store; the store and the screens read it through `DecisionSource` only.
import type { Delegation } from "../../../monos/model/delegations";
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

/** The source the app uses until WP-14: jobs from the delegation engine, nothing else waiting. */
export function delegationDecisions(listOpen: () => Promise<Delegation[]>): DecisionSource {
  return {
    async needs() {
      return { projects: [], setup: [] };
    },
    async jobs() {
      return delegationJobGroups(await listOpen().catch(() => []));
    },
    async checks() {
      return { checks: [] };
    },
    async act(action) {
      if (action === "job-seen" || action === "check-delivered") return {};
      throw new HubCallError("refused", "That isn't waiting on you any more.");
    },
  };
}
