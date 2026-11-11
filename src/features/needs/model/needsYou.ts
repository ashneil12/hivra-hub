// One list of everything that needs Ash. Every number on screen counts this list.
//
// Dedupe. One thing waiting on Ash is one item, even when two sources see it:
// 1. A worker's question that its Lead passed to Ash, and that worker's stopped row, are one item.
//    They share `about`. Keep the question.
// 2. A gate key in the decision store and in the gate log is one check. A chat cannot answer a
//    delivery gate key, so a chat row that names one is that check, not a question.
// 3. A chat and a decision that ask the same thing in the same project are the decision.
// 4. The same key collapses. When two kinds collide, keep the higher one:
//    check, then question, then approval, then merge, then review, then stopped.
// 5. A chat routed to its Lead is not Ash's. A grey waiting worker (With a Lead, retrying, stalled)
//    is not in this list.
//
// hubWork, hubBuilds and proposals are never read. A review whose repo is not one of Ash's
// project repos is left out.

export type NeedsKind = "stopped" | "question" | "approval" | "merge" | "review" | "check";

export type NeedsAction = { label: string; run: () => void };

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
  onAnswer?: () => void;
};

export type ApprovalFact = FactBase & {
  routedToLead?: boolean;
  onAllow?: () => void;
  onDeny?: () => void;
};

export type MergeFact = FactBase & {
  /** Answers the coding team's own question. This is not a new merge path. */
  onAnswer?: () => void;
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
  /** Repos that belong to one of Ash's projects. */
  ownRepos?: ReadonlySet<string>;
  /** Hub project ids. A review filed on one of these is that project's. */
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
  return `${projectId ?? ""}\n${sentence.trim().toLowerCase()}`;
}

type Draft = NeedsItem & {
  about?: string;
  gateKey?: string;
  same?: string;
  fromDecision?: boolean;
  decisionKey?: string;
};

function actionsOf(list: NeedsAction[]): NeedsAction[] {
  return list.filter((action) => action.label.trim()).slice(0, 2);
}

function openAction(label: string, run: (() => void) | undefined): NeedsAction[] {
  return run ? [{ label, run }] : [];
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
      actions: actionsOf([
        ...(fact.onAnswer ? [{ label: "Approve", run: fact.onAnswer }] : []),
        ...openAction("Open", fact.onOpen),
      ]),
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
    actions: actionsOf([
      ...(fact.onAnswer ? [{ label: fact.asMerge ? "Yes" : "Answer", run: fact.onAnswer }] : []),
      ...openAction("Open", fact.onOpen),
    ]),
    open: fact.open,
    about: fact.about,
    same: sentenceKey(fact.projectId, sentence),
    fromDecision: fact.fromDecision,
    decisionKey: fact.decisionKey,
  };
}

function approvalItem(fact: ApprovalFact, now: number): Draft | undefined {
  if (fact.routedToLead) return undefined;
  const id = fact.id.trim();
  if (!id) return undefined;
  const who = personName(fact.who);
  const sentence = plainSentence(fact.sentence);
  if (!sentence) return undefined;
  return {
    key: `approval:${id}`,
    kind: "approval",
    projectId: fact.projectId || undefined,
    monoId: fact.monoId || undefined,
    who,
    at: finite(fact.at, now),
    sentence,
    actions: actionsOf([
      ...(fact.onAllow ? [{ label: "Allow", run: fact.onAllow }] : []),
      ...(fact.onDeny ? [{ label: "Deny", run: fact.onDeny }] : []),
      ...openAction("Open", fact.onOpen),
    ]),
    open: fact.open,
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
      ...(fact.onAnswer ? [{ label: "Yes", run: fact.onAnswer }] : []),
      ...openAction("Open", fact.onOpen),
    ]),
    open: fact.open,
  };
}

function reviewItem(fact: ReviewFact, sources: NeedsSources, now: number): Draft | undefined {
  const repo = fact.repo.trim();
  const projectId = fact.projectId || undefined;
  const owned = (repo && sources.ownRepos?.has(repo)) || (projectId != null && sources.knownProjects?.has(projectId));
  if (!owned) return undefined;
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
  const decisions = new Set(rows.filter((row) => row.fromDecision && row.same).map((row) => row.same));
  rows = rows.filter((row) => row.fromDecision || !row.same || !decisions.has(row.same));
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
    }))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.at - b.at || a.key.localeCompare(b.key));
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
