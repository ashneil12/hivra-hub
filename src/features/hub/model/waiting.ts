// The ONE list of things waiting on Ash. Every page adds its items here; the
// strip counts, Today, each project's Inbox and every 'Take a look' button
// read only from this list.
import { hubData } from "./hubData";
import { listBuilds } from "./hubBuilds";
import { activeWorkers } from "./hubWork";
import { pendingProposals } from "./proposals";
import { pendingConnectors } from "./connectors";
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
  /** Set for a connector sign-in Need. */
  connectorId?: string;
  /** Button label on Today/Inbox; defaults to "Take a look". */
  actionLabel?: string;
  /** Where 'Take a look' from Today/Inbox goes. */
  target?: HubSelection;
};

/** At most 5 Needs show per project; the rest wait in Later. */
export const MAX_NEEDS = 5;

type Provider = (projectId: string) => WaitingItem[];

// Needs and valid proposals share the cap: a proposal is a Need. Beyond
// MAX_NEEDS per project the rest go under Later, like any other Need.
function needsAndProposals(pid: string): WaitingItem[] {
  const needs = hubData().listNeeds(pid).filter((n) => !n.later).map((n): WaitingItem => ({
    id: n.id, projectId: pid, source: "inbox", title: n.title, detail: n.why, need: n,
  }));
  const props = pendingProposals(pid).map((p): WaitingItem => ({
    id: `proposal:${p.id}`, projectId: pid, source: "proposal", title: p.title,
    detail: `Proposed by ${p.by}`, actionLabel: "Preview", target: { project: pid, item: `proposal:${p.id}` },
  }));
  // Each connector a restored setup needs is one Need until Ash signs in.
  const signIns = pendingConnectors(pid).map((c): WaitingItem => ({
    id: `connector:${c.id}`, projectId: pid, source: "inbox", title: `Sign in to ${c.name}`,
    detail: "Your restored bots use it. Passwords and keys never travel in the setup file.",
    actionLabel: "Sign in", connectorId: c.id,
  }));
  return [...signIns, ...needs, ...props];
}

/** Needs and proposals over the cap: waiting under Later, not counted. */
export function laterItems(projectId: string): WaitingItem[] {
  return needsAndProposals(projectId).slice(MAX_NEEDS);
}

const PROVIDERS: Provider[] = [
  // Inbox stuck items.
  (pid) =>
    hubData().listStuck(pid).map((s): WaitingItem => ({
      id: s.id, projectId: pid, source: "inbox", title: s.title, detail: s.detail, state: s.state,
      // Stuck items are talked through with the project's leadership team.
      target: { project: pid, item: "leadership-team", focus: s.id },
    })),
  // Needs plus valid proposals, at most MAX_NEEDS; the rest are Later.
  (pid) => needsAndProposals(pid).slice(0, MAX_NEEDS),
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
