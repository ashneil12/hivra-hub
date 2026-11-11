// The ONE list of things waiting on Ash. Every page adds its items here; the
// strip counts, Today, each project's Inbox and every 'Take a look' button
// read only from this list.
import { hubData } from "./hubData";
import { listBuilds } from "./hubBuilds";
import { activeWorkers } from "./hubWork";
import { pendingProposals } from "./proposals";
import { pendingSignIns, signInProblem, signInState } from "./connectors";
import { getTeam, openTeamsSettings, pendingMonoProposals } from "./hubTeams";
import type { HubSelection } from "./hubNav";
import type { Need, StuckState } from "./types";
import { openRows, waitingChats } from "./waitingChats";

export type WaitingItem = {
  id: string;
  projectId: string;
  /** Which page added it. */
  source: "inbox" | "builds" | "being-built" | "proposal";
  title: string;
  detail: string;
  /** Set for stuck / gave-up items; Needs have none. */
  state?: StuckState;
  /** The Lead a stuck item is with, for its "With <Lead>" chip. */
  lead?: string;
  need?: Need;
  /** Set for a connector sign-in Need. */
  connectorId?: string;
  /** A sign-in row: waiting on the Mac's Keychain prompt, or landed "On this Mac". */
  signIn?: "waiting" | "on-this-mac";
  /** A second quiet line under the detail (e.g. "Sent to coding team lead at 2:20pm · Got it"). */
  note?: string;
  /** A Need that was answered or cleared anywhere: shown ticked until Ash leaves the page, never counted. */
  done?: boolean;
  /** Button label on Today/Inbox; defaults to "Take a look". */
  actionLabel?: string;
  /** Where 'Take a look' from Today/Inbox goes. */
  target?: HubSelection;
  /** Instead of a target: what the button does (e.g. open Settings > Teams for a proposed Mono). */
  act?: () => void;
};

/** At most 5 Needs show per project; the rest wait in Later. */
export const MAX_NEEDS = 5;

type Provider = (projectId: string) => WaitingItem[];

// Every row on Today/Inbox shares the cap: stuck rows, Needs and proposals (a proposal is a Need). Stuck rows come
// first, then Needs, and beyond MAX_NEEDS open rows per project the rest go under Later. A Need ticked off in Ash OS
// stays in its place (not counted, not using a slot) until Ash leaves the page; Needs Ash OS itself files under Later
// go there too, after the overflow.
function needsAndProposals(pid: string): WaitingItem[] {
  return [
    ...hubData().listNeeds(pid).filter((n) => !n.later).map((n) => needItem(pid, n)),
    ...pendingProposals(pid).map((p): WaitingItem => ({
      id: `proposal:${p.id}`, projectId: pid, source: "proposal", title: p.title,
      detail: `Proposed by ${p.by}`, actionLabel: "Preview", target: { project: pid, item: `proposal:${p.id}` },
    })),
  ];
}

function needItem(pid: string, n: Need): WaitingItem {
  return { id: n.id, projectId: pid, source: "inbox", title: n.title, detail: n.why, need: n, ...(n.state === "done" ? { done: true } : {}) };
}

/** One project's rows, stuck first, capped at MAX_NEEDS open rows; the rest (and Ash OS's own Later) in `later`. */
function projectRows(pid: string): { shown: WaitingItem[]; later: WaitingItem[] } {
  const all = PROVIDERS.flatMap((p) => p(pid));
  const ordered = [...all.filter((i) => i.state), ...all.filter((i) => !i.state)];
  const shown: WaitingItem[] = [];
  const later: WaitingItem[] = [];
  let open = 0;
  for (const item of ordered) {
    if (item.done) shown.push(item);
    else if (open < MAX_NEEDS) { shown.push(item); open += 1; }
    else later.push(item);
  }
  const filed = hubData().listNeeds(pid).filter((n) => n.later).map((n) => needItem(pid, n));
  return { shown, later: [...later, ...filed] };
}

/** Rows over the cap, and the Needs Ash OS files under Later: waiting there, behind "N more under Later". */
export function laterItems(projectId: string): WaitingItem[] {
  return projectRows(projectId).later;
}

const PROVIDERS: Provider[] = [
  // Inbox stuck items.
  (pid) =>
    hubData().listStuck(pid).map((s): WaitingItem => ({
      id: s.id, projectId: pid, source: "inbox", title: s.title, detail: s.detail, state: s.state, ...(s.note ? { note: s.note } : {}), ...(s.lead ? { lead: s.lead } : {}),
      // Stuck items are talked through with the project's leadership team. A job that is stuck for real went to the
      // Lead by itself: no button.
      ...(s.quiet ? {} : { target: { project: pid, item: "leadership-team", focus: s.id } }),
    })),
  // Needs plus valid proposals (capped with everything else in projectRows).
  needsAndProposals,
  // Builds & playtests: failed builds that are stuck or gave up.
  (pid) =>
    listBuilds(pid).filter((b) => b.status === "failed" && b.stuck).map((b): WaitingItem => ({
      id: `build:${b.id}`, projectId: pid, source: "builds", state: b.stuck,
      title: `Build ${b.version}: ${b.title}`, detail: b.failReason ?? "", target: { project: pid, item: "builds" },
    })),
  // Being built: stuck workers not already covered by another item.
  (pid) =>
    activeWorkers(pid).filter((w) => w.stuck && !w.waitingId).map((w): WaitingItem => ({
      id: `worker:${w.id}`, projectId: pid, source: "being-built", state: w.stuck, lead: w.who,
      title: `${w.who}: ${w.doing}`, detail: w.steps[0]?.text ?? "", target: { project: pid, item: "being-built" },
    })),
];

/** The rows shown: per project stuck items first, then Needs, at most MAX_NEEDS open rows each. */
export function waitingOnAsh(projectId?: string): WaitingItem[] {
  const ids = projectId ? [projectId] : hubData().listProjects().map((p) => p.id);
  return ids.flatMap((pid) => projectRows(pid).shown);
}

/**
 * The open rows Today shows for the project (stuck rows included, at most MAX_NEEDS), the same in example and real data
 * (SPEC: "every count matches the items you can see"), plus its chats waiting on Ash. The strip badge and the project
 * card used to add the Stuck section's rows. The rail badge now reads the one Needs you list.
 * Later is not counted: its own line says how many wait there. A row that ticked itself off no longer counts.
 */
export function waitingCount(projectId: string): number {
  // r100 (d): a card with several decisions counts each open one, so the badge equals the asks Ash can answer.
  const asks = waitingChats(projectId).reduce((sum, chat) => sum + Math.max(1, openRows(chat).length), 0);
  return waitingOnAsh(projectId).filter((i) => !i.done).length + asks;
}

export function findWaiting(id: string): WaitingItem | undefined {
  const ids = hubData().listProjects().map((p) => p.id);
  return [...waitingOnAsh(), ...ids.flatMap((pid) => projectRows(pid).later)].find((i) => i.id === id);
}

/**
 * App-wide setup items (connector sign-ins after a restore). Shown once, in a
 * Setup group at the top of Today; never filed under a project or counted in
 * a project's strip count. Each goes away once signed in.
 */
export function setupItems(): WaitingItem[] {
  return [
    ...pendingSignIns().map((c): WaitingItem => {
      const state = signInState(c.id);
      return {
        id: `connector:${c.id}`, projectId: "", source: "inbox", title: `Sign in to ${c.name}`,
        detail: signInProblem(c.id) ?? "", actionLabel: "Sign in", connectorId: c.id, ...(state ? { signIn: state } : {}),
      };
    }),
    // A new named Mono an agent proposed waits for Ash's okay (hubTeams.ts); Review opens it on Settings > Teams.
    ...pendingMonoProposals().map((p): WaitingItem => ({
      id: `mono-proposal:${p.id}`, projectId: "", source: "proposal",
      title: `${p.proposedBy.name} proposes a new Mono: ${p.spec.name}`,
      detail: [p.teamId ? getTeam(p.teamId)?.name : p.teamName, p.spec.brief].filter(Boolean).join(" · "),
      actionLabel: "Review", act: openTeamsSettings,
    })),
    // Sign-ins Ash OS lists (nothing writes them yet). Read-only here: the Keychain sign-in is a later unit.
    ...hubData().listSetup().map((n): WaitingItem => ({
      id: `setup:${n.id}`, projectId: "", source: "inbox", title: n.title, detail: n.why, actionLabel: n.actionLabel,
    })),
  ];
}
