// One list of everything that needs Ash. Every number on screen counts this list.
//
// Dedupe. One thing waiting on Ash is one item, even when two sources see it:
// 1. A worker's question that its Lead passed to Ash, and that worker's stopped row, are one item.
//    They share `about`. Keep the question.
// 2. A gate key in the decision store and in the gate log is one check. A chat cannot answer a
//    delivery gate key, so a chat row that names one is that check, not a question.
// 3. A chat and a decision that ask the same thing are one item only when that chat asked the decision.
// 4. The same key collapses. When two kinds collide, keep the higher one:
//    check, then question, then approval, then merge, then review, then stopped.
// 5. A chat routed to its Lead is not Ash's. A grey waiting worker (With a Lead, retrying, stalled)
//    is not in this list.
//
// Order. A stopped or failed row leads, then a delivery check or work ready to merge (that holds a
// ship), then questions, approvals and reviews. Older first inside a group.
//
// hubWork, hubBuilds and proposals are never read. A review that names a repo counts only when
// that repo is one of the projects' own repos. A review with no repo counts for a known project.

import { callText, redListCategory } from "../../autopilot/model/redList";
import { ALWAYS_ASK_REASON, questionVeto } from "../../autopilot/model/reviewerRules";

export type NeedsKind = "stopped" | "question" | "approval" | "merge" | "review" | "check";

export type NeedsAction = { label: string; run: () => void; title?: string };

export type NeedsOpen =
  | { where: "chat"; id: string }
  | { where: "task"; id: string }
  | { where: "page"; id: string };

export type NeedsItem = {
  key: string;
  kind: NeedsKind;
  projectId?: string;
  /** Set when the item belongs to one Mono, so that Mono's red line can count it. */
  monoId?: string;
  who: string;
  at: number;
  sentence: string;
  actions: NeedsAction[];
  open?: NeedsOpen;
  /** Set when the item is a decision. Home opens the inbox on this key. */
  decisionKey?: string;
  /** Set when the item is a delivery check. Home opens that check. */
  gateKey?: string;
};

type FactBase = {
  id: string;
  projectId?: string;
  monoId?: string;
  who: string;
  at: number;
  sentence: string;
  open?: NeedsOpen;
  onOpen?: () => void;
};

export type StoppedFact = FactBase & {
  /** Shared with the question about this same worker. */
  about?: string;
  /** Grey waiting is not Ash's. Absent means it is. */
  forAsh?: boolean;
};

export type QuestionFact = FactBase & {
  about?: string;
  routedToLead?: boolean;
  /** This ask is a delivery gate key. It becomes a check and collapses with that gate. */
  gateKey?: string;
  /** The decision store, not a chat. A chat with the same question in the same project loses. */
  fromDecision?: boolean;
  /** The coding team says this is ready and waits on Ash's yes. The primary action answers it. */
  asMerge?: boolean;
  /** Set when this ask is a decision. Home opens that decision, not a task. */
  decisionKey?: string;
  /** The one-tap button names this option, and that is the answer it sends. */
  answerLabel?: string;
  /** Full words when the label is shortened. */
  answerTitle?: string;
  onAnswer?: () => void;
  /** The other answer. A merge shows this as Not yet unless otherLabel names it. */
  onNotYet?: () => void;
  otherLabel?: string;
  /** The chat this ask came from. A decision collapses with it only when askedBy matches. */
  sessionId?: string;
  /** The chat that asked this decision. */
  askedBy?: string;
};

export type ApprovalFact = FactBase & {
  routedToLead?: boolean;
  /** The chat already marked this step as a red line, even when the sentence is plain. */
  risky?: boolean;
  /** A page or plugin asking for access. One Review, never Allow or Deny. */
  reviewOnly?: boolean;
  /** Button words for the yes choice. A red-line row of a card says Approve once. */
  allowLabel?: string;
  /** Button words for the other choice. Absent means Deny. */
  denyLabel?: string;
  /** Set when this ask is a decision. Home opens the inbox on this key. */
  decisionKey?: string;
  onAllow?: () => void;
  onDeny?: () => void;
};

export type MergeFact = FactBase & {
  /** Answers the coding team's own question. This is not a new merge path. */
  onAnswer?: () => void;
  onNotYet?: () => void;
};

export type ReviewFact = FactBase & {
  repo: string;
};

export type CheckFact = FactBase & {
  gateKey?: string;
  onApprove?: () => void;
  onFix?: () => void;
};

export type RunningFact = { id: string; projectId?: string };

export type NeedsSources = {
  stopped?: readonly StoppedFact[];
  questions?: readonly QuestionFact[];
  approvals?: readonly ApprovalFact[];
  merges?: readonly MergeFact[];
  reviews?: readonly ReviewFact[];
  checks?: readonly CheckFact[];
  running?: readonly RunningFact[];
  /** Repos that belong to one of Ash's projects. Used when ownRepoByProject is absent. */
  ownRepos?: ReadonlySet<string>;
  /** Each project's own origin. When set, a review counts only against that project's repo. */
  ownRepoByProject?: ReadonlyMap<string, string>;
  /** Hub project ids. A review with no repo counts when its project is one of these. */
  knownProjects?: ReadonlySet<string>;
  /** Present only so a caller can prove they add nothing. Never read. */
  hubWork?: unknown;
  hubBuilds?: unknown;
  proposals?: unknown;
};

const RANK: Record<NeedsKind, number> = {
  check: 0,
  question: 1,
  approval: 2,
  merge: 3,
  review: 4,
  stopped: 5,
};

/** Display order only. Collapse still uses RANK, so a check still beats a question on the same key. */
function urgency(kind: NeedsKind): number {
  if (kind === "stopped") return 0;
  // A delivery check, or work that is ready to merge, is holding a ship.
  if (kind === "check" || kind === "merge") return 1;
  return 2;
}

const SENTENCE_MAX = 140;

let items: NeedsItem[] = [];
let running: readonly RunningFact[] = [];
let published = false;

function finite(value: number, now: number): number {
  return Number.isFinite(value) ? value : now;
}

/** A name a person would say. A bare id is not one. */
export function personName(who: string | null | undefined): string {
  const name = (who ?? "").replace(/\s+/g, " ").trim();
  if (!name) return "Coding team";
  if (/^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(name)) return "Coding team";
  if (!name.includes(" ") && /^(session|worker|lead|mono|chat)[-_:]/i.test(name)) return "Coding team";
  return name;
}

export function plainSentence(text: string): string {
  const flat = text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\bStuck\b/g, "stopped")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= SENTENCE_MAX) return flat;
  const cut = flat.slice(0, SENTENCE_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > 80 ? cut.slice(0, space) : cut).trimEnd();
}

function sentenceKey(projectId: string | undefined, sentence: string): string {
  const full = sentence.replace(/\s+/g, " ").trim().toLowerCase();
  return `${projectId ?? ""}\n${full}`;
}

type Draft = NeedsItem & {
  about?: string;
  gateKey?: string;
  same?: string;
  fromDecision?: boolean;
  decisionKey?: string;
  sessionId?: string;
  askedBy?: string;
};

function actionsOf(list: NeedsAction[]): NeedsAction[] {
  const seen = new Set<string>();
  const out: NeedsAction[] = [];
  for (const action of list) {
    const label = action.label.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ ...action, label });
    if (out.length === 2) break;
  }
  return out;
}

function openAction(label: string, run: (() => void) | undefined): NeedsAction[] {
  return run ? [{ label, run }] : [];
}

const RISKY_REASON = new Set<string>([
  ALWAYS_ASK_REASON.send,
  ALWAYS_ASK_REASON.delete,
  ALWAYS_ASK_REASON.pay,
  ALWAYS_ASK_REASON.publish,
  ALWAYS_ASK_REASON.account,
]);

/** A page or a plugin asking to read or use something. Not a red-line step Ash allows from Home. */
export function accessAsk(sentence: string): boolean {
  return /\b(?:page|plugin)\b/i.test(sentence) && /\basks\b/i.test(sentence);
}

function riskyStep(sentence: string): boolean {
  if (redListCategory(callText(sentence))) return true;
  const reason = questionVeto({ question: sentence });
  return reason != null && RISKY_REASON.has(reason);
}

function stoppedItem(fact: StoppedFact, now: number): Draft | undefined {
  if (fact.forAsh === false) return undefined;
  const id = fact.id.trim();
  if (!id) return undefined;
  const who = personName(fact.who);
  return {
    key: `stopped:${id}`,
    kind: "stopped",
    projectId: fact.projectId || undefined,
    monoId: fact.monoId || undefined,
    who,
    at: finite(fact.at, now),
    sentence: plainSentence(fact.sentence || `${who} stopped.`),
    actions: openAction("Open chat", fact.onOpen),
    open: fact.open,
    about: fact.about,
  };
}

function questionItem(fact: QuestionFact, now: number): Draft | undefined {
  if (fact.routedToLead) return undefined;
  const id = fact.id.trim();
  if (!id) return undefined;
  const who = personName(fact.who);
  const sentence = plainSentence(fact.sentence);
  if (!sentence) return undefined;
  if (fact.gateKey?.trim()) {
    const gateKey = fact.gateKey.trim();
    return {
      key: `check:${gateKey}`,
      kind: "check",
      projectId: fact.projectId || undefined,
      monoId: fact.monoId || undefined,
      who,
      at: finite(fact.at, now),
      sentence,
      actions: openAction("Open", fact.onOpen),
      open: fact.open,
      about: fact.about,
      gateKey,
      fromDecision: fact.fromDecision,
    };
  }
  const kind: NeedsKind = fact.asMerge ? "merge" : "question";
  return {
    key: `${kind}:${id}`,
    kind,
    projectId: fact.projectId || undefined,
    monoId: fact.monoId || undefined,
    who,
    at: finite(fact.at, now),
    sentence,
    actions: actionsOf(fact.asMerge
      ? [
        ...(fact.onAnswer ? [{ label: "Merge", run: fact.onAnswer }] : []),
        ...(fact.onNotYet ? [{ label: "Not yet", run: fact.onNotYet }] : []),
        ...openAction("Open", fact.onOpen),
      ]
      : [
        ...(fact.onAnswer ? [{
          label: fact.answerLabel?.trim() || "Answer",
          run: fact.onAnswer,
          ...(fact.answerTitle ? { title: fact.answerTitle } : {}),
        }] : []),
        ...(fact.onNotYet ? [{ label: fact.otherLabel?.trim() || "Not yet", run: fact.onNotYet }] : []),
        ...openAction("Open", fact.onOpen),
      ]),
    open: fact.open,
    about: fact.about,
    same: sentenceKey(fact.projectId, fact.sentence),
    fromDecision: fact.fromDecision,
    decisionKey: fact.decisionKey,
    sessionId: fact.sessionId,
    askedBy: fact.askedBy,
  };
}

function approvalItem(fact: ApprovalFact, now: number): Draft | undefined {
  if (fact.routedToLead) return undefined;
  const id = fact.id.trim();
  if (!id) return undefined;
  const who = personName(fact.who);
  const sentence = plainSentence(fact.sentence);
  if (!sentence) return undefined;
  const review = fact.reviewOnly === true || accessAsk(sentence);
  const allow = fact.allowLabel?.trim() || (fact.risky === true || riskyStep(sentence) ? "Allow once" : "Allow");
  return {
    key: `approval:${id}`,
    kind: "approval",
    projectId: fact.projectId || undefined,
    monoId: fact.monoId || undefined,
    who,
    at: finite(fact.at, now),
    sentence,
    actions: actionsOf(review
      ? openAction("Review", fact.onOpen)
      : [
        ...(fact.onAllow ? [{ label: allow, run: fact.onAllow }] : []),
        ...(fact.onDeny ? [{ label: fact.denyLabel?.trim() || "Deny", run: fact.onDeny }] : []),
        ...openAction("Open", fact.onOpen),
      ]),
    open: fact.open,
    ...(fact.decisionKey ? { decisionKey: fact.decisionKey } : {}),
  };
}

function mergeItem(fact: MergeFact, now: number): Draft | undefined {
  const id = fact.id.trim();
  if (!id) return undefined;
  const who = personName(fact.who || "Coding team");
  const sentence = plainSentence(fact.sentence);
  if (!sentence) return undefined;
  return {
    key: `merge:${id}`,
    kind: "merge",
    projectId: fact.projectId || undefined,
    monoId: fact.monoId || undefined,
    who,
    at: finite(fact.at, now),
    sentence,
    actions: actionsOf([
      ...(fact.onAnswer ? [{ label: "Merge", run: fact.onAnswer }] : []),
      ...(fact.onNotYet ? [{ label: "Not yet", run: fact.onNotYet }] : []),
      ...openAction("Open", fact.onOpen),
    ]),
    open: fact.open,
  };
}

/** A checkout may still say monocode-hub after the GitHub repo was renamed. No network. */
const REPO_ALIAS: Record<string, string> = {
  "ashneil12/monocode-hub": "ashneil12/hivra-hub",
  "ashneil12/hivra-hub": "ashneil12/monocode-hub",
};

/** Same repo, ignoring case, including one known rename. */
export function sameRepo(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || REPO_ALIAS[a] === b;
}

function reviewOwned(repo: string, projectId: string | undefined, sources: NeedsSources): boolean {
  if (!repo) return projectId != null && sources.knownProjects?.has(projectId) === true;
  const map = sources.ownRepoByProject;
  if (map) {
    const own = projectId ? map.get(projectId) : undefined;
    return own != null && sameRepo(repo, own);
  }
  for (const own of sources.ownRepos ?? []) {
    if (sameRepo(repo, own)) return true;
  }
  return false;
}

function reviewItem(fact: ReviewFact, sources: NeedsSources, now: number): Draft | undefined {
  const repo = fact.repo.trim();
  const projectId = fact.projectId || undefined;
  // A named repo counts only against that project's own origin, not every repo Ash has.
  if (!reviewOwned(repo, projectId, sources)) return undefined;
  const id = fact.id.trim();
  if (!id) return undefined;
  const sentence = plainSentence(fact.sentence);
  if (!sentence) return undefined;
  return {
    key: `review:${id}`,
    kind: "review",
    projectId,
    monoId: fact.monoId || undefined,
    who: personName(fact.who || "Coding team"),
    at: finite(fact.at, now),
    sentence,
    actions: openAction("Open", fact.onOpen),
    open: fact.open,
  };
}

function checkItem(fact: CheckFact, now: number): Draft | undefined {
  const id = (fact.gateKey ?? fact.id).trim();
  if (!id) return undefined;
  const sentence = plainSentence(fact.sentence);
  if (!sentence) return undefined;
  const gateKey = fact.gateKey?.trim() || undefined;
  return {
    key: `check:${gateKey ?? fact.id.trim()}`,
    kind: "check",
    projectId: fact.projectId || undefined,
    monoId: fact.monoId || undefined,
    who: personName(fact.who || "Coding team"),
    at: finite(fact.at, now),
    sentence,
    actions: actionsOf([
      ...(fact.onApprove ? [{ label: "Approve", run: fact.onApprove }] : []),
      ...(fact.onFix ? [{ label: "Fix", run: fact.onFix }] : []),
      ...openAction("Open", fact.onOpen),
    ]),
    open: fact.open,
    gateKey,
  };
}

function collapse(drafts: Draft[]): NeedsItem[] {
  const claimed = new Set(drafts.filter((row) => row.kind !== "stopped" && row.about).map((row) => row.about));
  let rows = drafts.filter((row) => !(row.kind === "stopped" && row.about && claimed.has(row.about)));
  const decisions = rows.filter((row) => row.fromDecision && row.same);
  rows = rows.filter((row) => {
    if (row.fromDecision || !row.same) return true;
    const session = row.sessionId?.trim() ?? "";
    if (!session) return true;
    return !decisions.some((decision) => decision.same === row.same && decision.askedBy?.trim() === session);
  });
  const kept = new Map<string, Draft>();
  for (const row of rows) {
    const key = row.gateKey ? `check:${row.gateKey}` : row.key;
    const prev = kept.get(key);
    const better = !prev
      || RANK[row.kind] < RANK[prev.kind]
      || (RANK[row.kind] === RANK[prev.kind] && row.actions.length > prev.actions.length)
      || (RANK[row.kind] === RANK[prev.kind] && row.actions.length === prev.actions.length && (row.at < prev.at || (row.at === prev.at && row.key < prev.key)));
    if (better) kept.set(key, { ...row, key });
  }
  return [...kept.values()]
    .map((row) => ({
      key: row.key,
      kind: row.kind,
      projectId: row.projectId,
      monoId: row.monoId,
      who: row.who,
      at: row.at,
      sentence: row.sentence,
      actions: row.actions,
      open: row.open,
      ...(row.decisionKey ? { decisionKey: row.decisionKey } : {}),
      ...(row.gateKey ? { gateKey: row.gateKey } : {}),
    }))
    .sort((a, b) => urgency(a.kind) - urgency(b.kind) || a.at - b.at || a.key.localeCompare(b.key));
}

function assemble(sources: NeedsSources, now: number): { items: NeedsItem[]; running: readonly RunningFact[] } {
  const drafts = [
    ...(sources.stopped ?? []).map((fact) => stoppedItem(fact, now)),
    ...(sources.questions ?? []).map((fact) => questionItem(fact, now)),
    ...(sources.approvals ?? []).map((fact) => approvalItem(fact, now)),
    ...(sources.merges ?? []).map((fact) => mergeItem(fact, now)),
    ...(sources.reviews ?? []).map((fact) => reviewItem(fact, sources, now)),
    ...(sources.checks ?? []).map((fact) => checkItem(fact, now)),
  ].filter((row): row is Draft => row != null);
  return { items: collapse(drafts), running: sources.running ?? [] };
}

/** Build the list and remember it, so the counts agree with what this call returned. */
export function needsYou(sources: NeedsSources, now: number): NeedsItem[] {
  const next = assemble(sources, now);
  items = next.items;
  running = next.running;
  published = true;
  return items;
}

/** The same list, without changing the counts the screen is showing. */
export function needsYouQuiet(sources: NeedsSources, now: number): NeedsItem[] {
  return assemble(sources, now).items;
}

/** True once a screen has published the list. A count note before that must not invent one. */
export function needsListPublished(): boolean {
  return published;
}

/** How many items need Ash. No project: the whole list, including items with no project. */
export function needsCount(projectId?: string): number {
  if (!projectId) return items.length;
  return items.filter((item) => item.projectId === projectId).length;
}

/** Running workers, from the app's own open delegations. Not a needs count. */
export function workingCount(projectId?: string): number {
  const rows = running.filter((row) => row.id.trim());
  if (!projectId) return rows.length;
  return rows.filter((row) => row.projectId === projectId).length;
}

/** A late result must not replace a newer one. A timeout (no value) keeps the last good list. */
export function takeLatest<T>(generation: number, current: number, value: T | undefined, previous: T): T {
  if (generation !== current || value === undefined) return previous;
  return value;
}
