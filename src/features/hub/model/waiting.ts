// The ONE list of things waiting on Ash. Every page adds its items here; the
// strip counts, Today, each project's Inbox and every 'Take a look' button
// read only from this list.
import { hubData } from "./hubData";
import { listBuilds } from "./hubBuilds";
import { activeWorkers } from "./hubWork";
import { pendingProposals } from "./proposals";
import type { HubSelection } from "./hubNav";
import type { Need, StuckState } from "./types";

export type WaitingItem = {
  id: string;
  projectId: string;
  /** Which page added it. */
  source: "inbox" | "builds" | "being-built" | "proposal";
  title: string;
  detail: string;
  /** Set for stuck / gave-up items; Needs have none. */
  state?: StuckState;
  need?: Need;
  /** Button label on Today/Inbox; defaults to "Take a look". */
  actionLabel?: string;
  /** Where 'Take a look' from Today/Inbox goes. */
  target?: HubSelection;
};

/** At most 5 Needs show per project; the rest wait in Later. */
export const MAX_NEEDS = 5;

type Provider = (projectId: string) => WaitingItem[];

const PROVIDERS: Provider[] = [
  // Inbox: Needs and stuck items from the data source.
  (pid) => [
    ...hubData().listStuck(pid).map((s): WaitingItem => ({
      id: s.id, projectId: pid, source: "inbox", title: s.title, detail: s.detail, state: s.state,
      // Stuck items are talked through with the project's leadership team.
      target: { project: pid, item: "leadership-team", focus: s.id },
    })),
    ...hubData().listNeeds(pid).filter((n) => !n.later).slice(0, MAX_NEEDS).map((n): WaitingItem => ({
      id: n.id, projectId: pid, source: "inbox", title: n.title, detail: n.why, need: n,
    })),
  ],
  // Builds & playtests: failed builds that are stuck or gave up.
  (pid) =>
    listBuilds(pid).filter((b) => b.status === "failed" && b.stuck).map((b): WaitingItem => ({
      id: `build:${b.id}`, projectId: pid, source: "builds", state: b.stuck,
      title: `Build ${b.version}: ${b.title}`, detail: b.failReason ?? "", target: { project: pid, item: "builds" },
    })),
  // Being built: stuck workers not already covered by another item.
  (pid) =>
    activeWorkers(pid).filter((w) => w.stuck && !w.waitingId).map((w): WaitingItem => ({
      id: `worker:${w.id}`, projectId: pid, source: "being-built", state: w.stuck,
      title: `${w.who}: ${w.doing}`, detail: w.steps[0]?.text ?? "", target: { project: pid, item: "being-built" },
    })),
  // Self-change proposals: one item each.
  (pid) =>
    pendingProposals(pid).map((p): WaitingItem => ({
      id: `proposal:${p.id}`, projectId: pid, source: "proposal", title: p.title,
      detail: p.blocked ? `Blocked: ${p.blocked.rule}` : `Proposed by ${p.by}`,
      actionLabel: "Preview", target: { project: pid, item: `proposal:${p.id}` },
    })),
];

/** Stuck items first, then Needs. */
export function waitingOnAsh(projectId?: string): WaitingItem[] {
  const ids = projectId ? [projectId] : hubData().listProjects().map((p) => p.id);
  const all = ids.flatMap((pid) => PROVIDERS.flatMap((p) => p(pid)));
  return [...all.filter((i) => i.state), ...all.filter((i) => !i.state)];
}

export function waitingCount(projectId: string): number {
  return waitingOnAsh(projectId).length;
}

export function findWaiting(id: string): WaitingItem | undefined {
  return waitingOnAsh().find((i) => i.id === id);
}
