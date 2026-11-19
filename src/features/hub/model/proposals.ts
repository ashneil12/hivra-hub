import { examples } from "./examples";
// Self-change proposals: the app or a Mono proposes a change to its own look
// or a dashboard. Checked against DESIGN-RULES.md; applied only on Ash's yes,
// with one-step undo. Mock for now; the edit-dashboard skill feeds the real ones.
import { useSyncExternalStore } from "react";

/** A tiny description of a screen, drawn as a calm before/after sketch. */
export type PreviewSketch = { heading: string; rows: { text: string; isNew?: boolean; moved?: boolean }[] };

export type Proposal = {
  id: string;
  projectId: string;
  /** Who proposed it: a Mono name or "Monocode". */
  by: string;
  title: string;
  why: string;
  /** Design rules it was checked against (passed). */
  checked: string[];
  /** Set when it breaks a rule: it can't be applied. */
  blocked?: { rule: string; reason: string };
  before: PreviewSketch;
  after: PreviewSketch;
  /** "rejected" = turned down automatically for breaking a design rule; never shown to Ash. */
  status: "pending" | "applied" | "dismissed" | "undone" | "rejected";
  appliedAt?: string;
};

const RULES = {
  colour: "Colour only for status",
  edges: "No edges or glow",
  needs: "At most 5 Needs",
  example: "Placeholder data says 'Example:'",
  nav: "No new navigation",
};

let proposals: Proposal[] = examples([
  {
    id: "p1", projectId: "hivra", by: "Hivra lead", status: "pending",
    title: "Example: add a Waitlist card to Hivra's Today",
    why: "Example: you check sign-ups every morning; this puts the number where you already look.",
    checked: [RULES.colour, RULES.edges, RULES.needs, RULES.example],
    before: { heading: "Hivra · Today", rows: [{ text: "Since 2pm" }, { text: "Nightly backup failing" }, { text: "Email sender broken" }, { text: "Pick the waitlist headline" }] },
    after: { heading: "Hivra · Today", rows: [{ text: "Since 2pm" }, { text: "Waitlist: 412 sign-ups, +38 today", isNew: true }, { text: "Nightly backup failing" }, { text: "Email sender broken" }, { text: "Pick the waitlist headline" }] },
  },
  {
    id: "p2", projectId: "exo-game", by: "Projects manager", status: "pending",
    title: "Example: move Builds & playtests above Leadership team",
    why: "Example: you opened Builds 9 times this week and Leadership twice.",
    checked: [RULES.nav, RULES.edges, RULES.colour],
    before: { heading: "EXO game sidebar", rows: [{ text: "Coding team" }, { text: "Leadership team" }, { text: "Builds & playtests" }, { text: "Being built" }] },
    after: { heading: "EXO game sidebar", rows: [{ text: "Coding team" }, { text: "Builds & playtests", moved: true }, { text: "Leadership team" }, { text: "Being built" }] },
  },
  {
    id: "p3", projectId: "exo-game", by: "Alfred", status: "rejected", appliedAt: "Today 7:48pm",
    title: "Example: give Stuck rows an orange glowing edge",
    why: "Example: so stuck work is harder to miss.",
    checked: [RULES.needs, RULES.example],
    blocked: { rule: RULES.edges, reason: "Stuck work is shown by a 14px grey ring and a plain word (Retrying, With <Lead>); red only for Needs you. Edges and glow are not allowed anywhere." },
    before: { heading: "EXO game · Today", rows: [{ text: "Build 0.13.1 · Stuck" }, { text: "Play Areas 1 and 2" }] },
    after: { heading: "EXO game · Today", rows: [{ text: "Build 0.13.1 · Stuck, with orange glowing edge", isNew: true }, { text: "Play Areas 1 and 2" }] },
  },
  {
    // Harness already has 5 Needs, so this valid proposal waits under Later.
    id: "p4", projectId: "harness", by: "Chief of Staff", status: "pending",
    title: "Example: add a Hiring card to the Harness Today",
    why: "Example: three open roles move every day.",
    checked: [RULES.colour, RULES.edges, RULES.needs, RULES.example],
    before: { heading: "Harness · Today", rows: [{ text: "Since 2pm" }, { text: "Approve the Q4 hiring plan" }] },
    after: { heading: "Harness · Today", rows: [{ text: "Since 2pm" }, { text: "Hiring: 3 open roles", isNew: true }, { text: "Approve the Q4 hiring plan" }] },
  },
  {
    id: "p0", projectId: "hivra", by: "Monocode", status: "applied", appliedAt: "Yesterday 6:12pm",
    title: "Example: added a Dashboards section to Hivra",
    why: "Example: the weekly numbers live in a hub kept for Hivra.",
    checked: [RULES.nav], before: { heading: "", rows: [] }, after: { heading: "", rows: [] },
  },
  {
    id: "pm1", projectId: "exo-game", by: "Monocode", status: "applied", appliedAt: "12 Oct",
    title: "Example: added Being built to EXO game",
    why: "Example: two Monos were working at once.",
    checked: [RULES.nav], before: { heading: "", rows: [] }, after: { heading: "", rows: [] },
  },
]);

const EVENT = "monocode:hub-proposals-changed";
let version = 0;
function changed(): void {
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
export function useProposalsVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
}

/** Rule-breaking proposals never reach Ash: the app turns them down itself. */
function autoReject(): void {
  proposals = proposals.map((p) => (p.blocked && p.status === "pending" ? { ...p, status: "rejected", appliedAt: p.appliedAt ?? "Just now" } : p));
}
autoReject();

export function pendingProposals(projectId: string): Proposal[] {
  return proposals.filter((p) => p.projectId === projectId && p.status === "pending" && !p.blocked);
}
export function getProposal(id: string): Proposal | undefined {
  return proposals.find((p) => p.id === id);
}
/** Applied, undone and auto-rejected changes, newest first. */
export function pastChanges(): Proposal[] {
  return proposals.filter((p) => p.status === "applied" || p.status === "undone" || p.status === "rejected");
}

function set(id: string, patch: Partial<Proposal>): void {
  proposals = proposals.map((p) => (p.id === id ? { ...p, ...patch } : p));
  changed();
}
/** Refuses a blocked proposal: a change that breaks a design rule never goes live. */
export function applyProposal(id: string): void {
  const p = getProposal(id);
  if (!p || p.blocked) throw new Error("Blocked by a design rule; it can't be applied.");
  // Newest first in Changes.
  proposals = [{ ...p, status: "applied", appliedAt: "Just now" }, ...proposals.filter((x) => x.id !== id)];
  changed();
}
export function dismissProposal(id: string): void {
  set(id, { status: "dismissed" });
}
export function undoProposal(id: string): void {
  set(id, { status: "undone" });
}
