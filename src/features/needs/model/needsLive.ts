// Live facts for the one Needs you list. Worker rows come from needsYouRows, not a second worker list.
// A late read loses to a newer one. A timeout keeps the last good remote facts.
// Only useNeedsYou publishes the list. A quiet read (Home's opening count) must not replace it.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { projectKey } from "../../../shared/lib/paths";
import { DECISIONS_CHANGED, tauriFirstMate, type Decision } from "../../firstmate/model/steering";
import { useDelegationRows } from "../../monos/model/delegationStore";
import { findMono } from "../../monos/model/mono";
import { openFromHome } from "../../home/model/opener";
import { allKeptPages, needsAllow, requestOpenPage, usePagesVersion, type Page } from "../../pages/model/pages";
import { PR_WATCHES_CHANGED, tauriPrWatches, type PrWatch } from "../../pr-watch/model/prWatches";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import {
  answerApproval,
  answerPermission,
  openRows,
  openWaitingChat,
  takePick,
  useWaitingChatsVersion,
  waitingChats,
  type WaitingChat,
} from "../../hub/model/waitingChats";
import { useNeedsYouRows } from "../../hub/model/useNeedsYouRows";
import type { NeedsYouRow } from "../../hub/model/needsYouRows";
import type { HomeDecision, HomeProject, HomeTask } from "../../home/model/lines";
import {
  accessAsk,
  needsYou,
  takeLatest,
  type ApprovalFact,
  type CheckFact,
  type NeedsItem,
  type NeedsSources,
  type QuestionFact,
  type ReviewFact,
  type RunningFact,
  type StoppedFact,
} from "./needsYou";

const REVIEW = "In review";
const MERGE_PHRASE = /\bready to merge\b/i;
const APPROVAL_PHRASE = /\b(?:wants to run|asks to read|asks for access)\b/i;

export type GateCard = {
  projectId: string;
  id: string;
  line: string;
  decisionKey: string | null;
  state: string;
};

export type RemoteNeeds = {
  decisions: Decision[];
  cards: GateCard[];
  watches: PrWatch[];
};

export type ProjectRef = { id: string; name: string; folder: string | null };

export type NeedsDelegation = { id: string; state: string; project: string | null };

const EMPTY_REMOTE: RemoteNeeds = { decisions: [], cards: [], watches: [] };

function projects(): ProjectRef[] {
  return hubData().listProjects().map((project) => ({
    id: project.id,
    name: project.name,
    folder: project.folder ?? null,
  }));
}

export function projectIdOf(raw: string | null | undefined, list: readonly ProjectRef[]): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const hit = list.find((project) => project.id === value || (project.folder != null && project.folder !== "" && projectKey(project.folder) === projectKey(value)));
  return hit?.id;
}

function monoName(id: string | null | undefined, fallback: string): string {
  if (!id) return fallback;
  return findMono(id)?.name || fallback;
}

/**
 * A seeded fault starts with "Example:" so a shot cannot be read as a real one. The plain line
 * ("Out of credits") drops that mark. Put it back when the raw fault carried it.
 */
export function keepExampleMark(plain: string, raw: string | null | undefined): string {
  const line = plain.replace(/\s+/g, " ").trim();
  const source = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!source.startsWith("Example:") || line.startsWith("Example:")) return line;
  return `Example: ${line}`;
}

function stoppedFacts(rows: readonly NeedsYouRow[]): StoppedFact[] {
  return rows.map((row) => {
    const job = row.job;
    const worker = row.worker;
    const who = job?.who || monoName(row.lead, "Coding team");
    const plain = worker?.line || job?.stuckReason || job?.stateReason || job?.doing || "Needs you.";
    // A job row's stuckReason is already the plain line. The raw fault, including a seeded "Example:" mark, is on the worker it carries.
    const sentence = keepExampleMark(plain, worker?.row.error ?? job?.stuckWorker?.row.error);
    const about = worker?.key || job?.stuckWorker?.key;
    const chatId = worker?.row.childSession || job?.id;
    return {
      id: row.key,
      projectId: row.projectId ?? undefined,
      monoId: row.lead ?? undefined,
      who,
      at: worker?.since ?? 0,
      sentence,
      about,
      forAsh: true,
      ...(chatId ? { open: { where: "chat" as const, id: chatId }, onOpen: () => openWaitingChat(chatId) } : {}),
    };
  });
}

function rowFacts(chat: WaitingChat, question: string, id: string): QuestionFact | ApprovalFact {
  const base = {
    id,
    projectId: chat.projectId ?? undefined,
    monoId: chat.monoId,
    who: chat.chatName || "Coding team",
    at: chat.askedAt,
    sentence: question,
    open: { where: "chat" as const, id: chat.sessionId },
    onOpen: () => openWaitingChat(chat.sessionId),
    routedToLead: chat.routedToLead,
  };
  if (accessAsk(question)) return { ...base, reviewOnly: true };
  if (chat.source === "permission") {
    return {
      ...base,
      onAllow: () => { answerPermission(chat.sessionId, "allow"); },
      onDeny: () => { answerPermission(chat.sessionId, "deny"); },
    };
  }
  if (chat.redLine || chat.gate?.kind === "approval") {
    const seen = { question: chat.question, askedAt: chat.askedAt, pick: chat.pick };
    return {
      ...base,
      ...(chat.redLine ? { risky: true } : {}),
      onAllow: () => { void answerApproval(chat.sessionId, "approve-once", seen); },
      onDeny: () => { void answerApproval(chat.sessionId, "deny", seen); },
    };
  }
  return {
    ...base,
    asMerge: MERGE_PHRASE.test(question),
    ...(chat.pick ? { onAnswer: () => { void takePick(chat.sessionId, { by: "ash" }); } } : {}),
  };
}

/** Chat questions and permission asks, one fact per open row. A merge stays a question so the decision wins. */
export function factsFromChats(chats: readonly WaitingChat[]): { questions: QuestionFact[]; approvals: ApprovalFact[] } {
  const questions: QuestionFact[] = [];
  const approvals: ApprovalFact[] = [];
  for (const chat of chats) {
    const rows = openRows(chat);
    const asks = rows.length
      ? rows.map((row, index) => ({ question: row.question, id: `${chat.sessionId}:${row.questionId ?? index}` }))
      : [{ question: chat.question, id: chat.sessionId }];
    for (const ask of asks) {
      if (!ask.question.trim()) continue;
      const fact = rowFacts(chat, ask.question, ask.id);
      if (("reviewOnly" in fact && fact.reviewOnly) || "onAllow" in fact) approvals.push(fact);
      else questions.push(fact);
    }
  }
  return { questions, approvals };
}

function yesAnswer(decision: Decision): () => void {
  return () => {
    void tauriFirstMate.answer(decision.project, decision.decisionKey, decision.recommended ?? decision.options[0] ?? "Yes");
  };
}

function notYetAnswer(decision: Decision): () => void {
  return () => {
    const yes = decision.recommended ?? decision.options[0] ?? "Yes";
    const other = decision.options.find((option) => option !== yes);
    void tauriFirstMate.answer(decision.project, decision.decisionKey, other ?? "Not yet");
  };
}

function decisionFacts(
  decisions: readonly Decision[],
  list: readonly ProjectRef[],
  parked: ReadonlySet<string>,
): { questions: QuestionFact[]; approvals: ApprovalFact[] } {
  const questions: QuestionFact[] = [];
  const approvals: ApprovalFact[] = [];
  for (const decision of decisions) {
    if (decision.state !== "open" || !decision.decisionKey.trim() || !decision.question.trim()) continue;
    const base = {
      id: `${decision.project}:${decision.decisionKey}`,
      projectId: projectIdOf(decision.project, list),
      monoId: decision.askedByMono ?? undefined,
      who: monoName(decision.askedByMono, "Coding team"),
      at: decision.createdAt,
      sentence: decision.question,
      decisionKey: decision.decisionKey,
    };
    if (parked.has(decision.decisionKey)) {
      questions.push({ ...base, fromDecision: true, gateKey: decision.decisionKey, onAnswer: yesAnswer(decision) });
      continue;
    }
    if (accessAsk(decision.question)) {
      approvals.push({
        ...base,
        reviewOnly: true,
        onOpen: () => openFromHome({
          kind: "inbox",
          projectId: base.projectId ?? "",
          decisionKey: decision.decisionKey,
        }),
      });
      continue;
    }
    if (APPROVAL_PHRASE.test(decision.question)) {
      approvals.push({
        ...base,
        onAllow: yesAnswer(decision),
        onDeny: () => { void tauriFirstMate.answer(decision.project, decision.decisionKey, "No"); },
      });
      continue;
    }
    const merge = MERGE_PHRASE.test(decision.question);
    questions.push({
      ...base,
      fromDecision: true,
      asMerge: merge,
      onAnswer: yesAnswer(decision),
      ...(merge ? { onNotYet: notYetAnswer(decision) } : {}),
    });
  }
  return { questions, approvals };
}

function taskFacts(tasks: readonly HomeTask[], list: readonly ProjectRef[]): { questions: QuestionFact[]; reviews: ReviewFact[] } {
  const questions: QuestionFact[] = [];
  const reviews: ReviewFact[] = [];
  for (const task of tasks) {
    const title = task.title.trim();
    if (!title || task.trashedAt != null) continue;
    const projectId = projectIdOf(task.projectId, list) ?? (task.projectId || undefined);
    const shared = {
      id: `task:${task.id}`,
      projectId,
      who: task.assignee || "Coding team",
      at: task.createdAt,
      sentence: title,
      open: { where: "task" as const, id: task.id },
    };
    if (task.status === REVIEW) reviews.push({ ...shared, repo: "" });
    else if (task.needsYou) questions.push(shared);
  }
  return { questions, reviews };
}

function cardFacts(cards: readonly GateCard[], list: readonly ProjectRef[]): CheckFact[] {
  return cards.flatMap((card) => {
    if (card.state !== "parked" || !card.decisionKey || !card.line.trim()) return [];
    const key = card.decisionKey;
    return [{
      id: card.id,
      gateKey: key,
      projectId: projectIdOf(card.projectId, list),
      who: "Coding team",
      at: 0,
      sentence: card.line,
      onApprove: () => { void invoke("gate_respond", { decisionKey: key, answer: "Approve", project: card.projectId }); },
      onFix: () => { void invoke("gate_respond", { decisionKey: key, answer: "Fix", project: card.projectId }); },
    }];
  });
}

function watchFacts(watches: readonly PrWatch[], list: readonly ProjectRef[]): ReviewFact[] {
  return watches.flatMap((watch) => {
    if (watch.state === "ended") return [];
    const review = watch.status?.reviewDecision;
    if (review !== "REVIEW_REQUIRED" && review !== "CHANGES_REQUESTED") return [];
    const projectId = projectIdOf(watch.project, list);
    if (!projectId) return [];
    const title = typeof watch.title === "string" ? watch.title.trim() : "";
    return [{
      id: watch.id,
      projectId,
      repo: typeof watch.repo === "string" ? watch.repo : "",
      monoId: watch.ownerMono ?? undefined,
      who: watch.ownerName || monoName(watch.ownerMono, "Coding team"),
      at: watch.updatedAt,
      sentence: title || `Review pull request #${watch.number}.`,
      open: { where: "chat" as const, id: watch.ownerSession },
      onOpen: () => openWaitingChat(watch.ownerSession),
    }];
  });
}

function pageFacts(pages: readonly Page[], list: readonly ProjectRef[]): ApprovalFact[] {
  return pages.filter(needsAllow).map((page) => ({
    id: page.id,
    projectId: projectIdOf(page.projectId, list),
    who: "Coding team",
    at: page.keptAt ?? 0,
    sentence: `${page.title || "A page"} asks for access.`,
    open: { where: "page" as const, id: page.id },
    reviewOnly: true,
    onOpen: () => {
      requestOpenPage(page.id);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: "pages" }));
      }
    },
  }));
}

function runningFacts(rows: readonly NeedsDelegation[], list: readonly ProjectRef[]): RunningFact[] {
  return rows.filter((row) => row.state === "running" && row.id.trim()).map((row) => ({
    id: row.id,
    projectId: projectIdOf(row.project, list),
  }));
}

function ownedRepos(watches: readonly PrWatch[], list: readonly ProjectRef[]): Set<string> {
  const repos = new Set<string>();
  for (const watch of watches) {
    const repo = typeof watch.repo === "string" ? watch.repo.trim() : "";
    if (repo && projectIdOf(watch.project, list)) repos.add(repo);
  }
  return repos;
}

function homeDecision(decision: HomeDecision): Decision {
  return {
    project: decision.project,
    decisionKey: decision.decisionKey,
    question: decision.question,
    options: [],
    recommended: null,
    askedBy: "",
    askedByMono: null,
    waiting: [],
    state: decision.state === "open" ? "open" : "answered",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: decision.createdAt,
    updatedAt: decision.createdAt,
    version: 1,
  };
}

function safeChats(): WaitingChat[] {
  try {
    return waitingChats();
  } catch {
    return [];
  }
}

function safePages(): Page[] {
  try {
    return allKeptPages();
  } catch {
    return [];
  }
}

/** Home's decisions and tasks, plus the chats already waiting. A chat store that throws adds nothing. */
export function factsFromHome(
  decisions: readonly HomeDecision[],
  tasks: readonly HomeTask[],
  homeProjects: readonly HomeProject[],
): NeedsSources {
  const list = homeProjects.map((project) => ({ id: project.id, name: project.name, folder: project.folder }));
  const fromDecisions = decisionFacts(decisions.map(homeDecision), list, new Set());
  const fromTasks = taskFacts(tasks, list);
  const chats = factsFromChats(safeChats());
  return {
    questions: [...fromDecisions.questions, ...fromTasks.questions, ...chats.questions],
    approvals: [...fromDecisions.approvals, ...chats.approvals],
    reviews: fromTasks.reviews,
    knownProjects: new Set(list.map((project) => project.id)),
    ownRepos: new Set<string>(),
  };
}

export type NeedsParts = {
  remote: RemoteNeeds;
  rows: readonly NeedsYouRow[];
  projects: readonly ProjectRef[];
  chats: readonly WaitingChat[];
  pages: readonly Page[];
  delegations: readonly NeedsDelegation[];
};

/** One read of every source. Callers pass what they already hold, so a test never needs the live stores. */
export function factsFromParts(parts: NeedsParts): NeedsSources {
  const list = parts.projects;
  const parked = new Set(parts.remote.cards.filter((card) => card.state === "parked" && card.decisionKey).map((card) => card.decisionKey as string));
  const decisions = decisionFacts(parts.remote.decisions, list, parked);
  const chats = factsFromChats(parts.chats);
  return {
    stopped: stoppedFacts(parts.rows),
    questions: [...decisions.questions, ...chats.questions],
    approvals: [...decisions.approvals, ...chats.approvals, ...pageFacts(parts.pages, list)],
    reviews: watchFacts(parts.remote.watches, list),
    checks: cardFacts(parts.remote.cards, list),
    running: runningFacts(parts.delegations, list),
    ownRepos: ownedRepos(parts.remote.watches, list),
    knownProjects: new Set(list.map((project) => project.id)),
  };
}

function asDecision(value: unknown): Decision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<Decision>;
  if (typeof row.decisionKey !== "string" || typeof row.question !== "string" || typeof row.state !== "string") return undefined;
  if (!row.decisionKey.trim()) return undefined;
  return {
    project: typeof row.project === "string" ? row.project : "",
    decisionKey: row.decisionKey,
    question: row.question,
    options: Array.isArray(row.options) ? row.options.filter((option): option is string => typeof option === "string") : [],
    recommended: typeof row.recommended === "string" ? row.recommended : null,
    askedBy: typeof row.askedBy === "string" ? row.askedBy : "",
    askedByMono: typeof row.askedByMono === "string" ? row.askedByMono : null,
    waiting: [],
    state: row.state === "answered" ? "answered" : "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    version: typeof row.version === "number" ? row.version : 1,
  };
}

function asCard(projectId: string, value: unknown): GateCard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const state = typeof row.state === "string" ? row.state.trim() : "";
  if (!id || !state || typeof row.line !== "string") return undefined;
  return {
    projectId,
    id,
    line: row.line,
    decisionKey: typeof row.decisionKey === "string" && row.decisionKey.trim() ? row.decisionKey : null,
    state,
  };
}

function asWatch(value: unknown): PrWatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<PrWatch>;
  if (typeof row.id !== "string" || !row.id.trim()) return undefined;
  if (row.state !== "watching" && row.state !== "ended") return undefined;
  if (!row.status || typeof row.status !== "object") return undefined;
  return {
    ...row,
    id: row.id,
    repo: typeof row.repo === "string" ? row.repo : "",
    number: typeof row.number === "number" ? row.number : 0,
    title: typeof row.title === "string" ? row.title : "",
    project: typeof row.project === "string" ? row.project : null,
    ownerSession: typeof row.ownerSession === "string" ? row.ownerSession : "",
    ownerMono: typeof row.ownerMono === "string" ? row.ownerMono : null,
    ownerName: typeof row.ownerName === "string" ? row.ownerName : null,
    state: row.state,
    status: row.status,
    updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
  } as PrWatch;
}

/**
 * A timed-out project keeps its last cards. Every read timing out keeps the whole previous list
 * (`undefined`). A null or any other non-list is an empty answer for that project, not a failure.
 */
export function cardsAfter(
  previous: readonly GateCard[],
  reads: readonly { projectId: string; got: unknown }[],
): GateCard[] | undefined {
  if (reads.length === 0 || reads.every((entry) => entry.got === undefined)) return undefined;
  const kept = new Map<string, GateCard[]>();
  for (const card of previous) {
    const list = kept.get(card.projectId) ?? [];
    list.push(card);
    kept.set(card.projectId, list);
  }
  const next: GateCard[] = [];
  for (const entry of reads) {
    if (entry.got === undefined) {
      next.push(...(kept.get(entry.projectId) ?? []));
      continue;
    }
    if (!Array.isArray(entry.got)) continue;
    for (const row of entry.got) {
      const card = asCard(entry.projectId, row);
      if (card) next.push(card);
    }
  }
  return next;
}

/** A missing patch, or a missing field, keeps what we last showed. */
export function mergeRemote(previous: RemoteNeeds, patch: Partial<RemoteNeeds> | undefined): RemoteNeeds {
  if (patch === undefined) return previous;
  return {
    decisions: patch.decisions ?? previous.decisions,
    cards: patch.cards ?? previous.cards,
    watches: patch.watches ?? previous.watches,
  };
}

let remote: RemoteNeeds = EMPTY_REMOTE;
let remoteGen = 0;
const listeners = new Set<() => void>();

function publishRemote(next: RemoteNeeds) {
  if (next === remote) return;
  remote = next;
  for (const listener of listeners) listener();
}

async function orUndefined<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch {
    return undefined;
  }
}

/** Reload decisions, gate cards and pull-request watches. A timeout or a late reply keeps the previous facts. */
export async function refreshNeedsRemote(): Promise<void> {
  const mine = ++remoteGen;
  const list = projects();
  const [decisionsRaw, watchesRaw, ...cardReads] = await Promise.all([
    orUndefined(tauriFirstMate.decisions(0)),
    orUndefined(tauriPrWatches.list()),
    ...list.map(async (project) => {
      const folder = project.folder?.trim() || project.id;
      return { projectId: folder, got: await orUndefined(invoke("gate_cards", { project: folder })) };
    }),
  ]);
  const decisions = decisionsRaw === undefined ? undefined : (Array.isArray(decisionsRaw) ? decisionsRaw.map(asDecision).filter((row): row is Decision => row != null) : []);
  const watches = watchesRaw === undefined ? undefined : (Array.isArray(watchesRaw) ? watchesRaw.map(asWatch).filter((row): row is PrWatch => row != null) : []);
  const cards = cardsAfter(remote.cards, cardReads);
  const patch = decisions === undefined && watches === undefined && cards === undefined
    ? undefined
    : { decisions, watches, cards };
  const next = takeLatest(mine, remoteGen, patch === undefined ? undefined : mergeRemote(remote, patch), remote);
  publishRemote(next);
}

function subscribeRemote(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function resetNeedsLiveForTest(): void {
  remote = EMPTY_REMOTE;
  remoteGen = 0;
  listeners.clear();
}

export function useNeedsYou(): NeedsItem[] {
  useHubDataVersion();
  useWaitingChatsVersion();
  usePagesVersion();
  const rows = useNeedsYouRows();
  const delegations = useDelegationRows();
  const [, setTick] = useState(0);
  useEffect(() => {
    let stopped = false;
    const on = () => { if (!stopped) setTick((n) => n + 1); };
    const stop = subscribeRemote(on);
    const refresh = () => { if (!stopped) void refreshNeedsRemote(); };
    refresh();
    const stops: (() => void)[] = [];
    const hear = (name: string) => {
      void listen(name, refresh).then((un) => {
        if (stopped) un();
        else stops.push(un);
      }, () => undefined);
    };
    hear(DECISIONS_CHANGED);
    hear(PR_WATCHES_CHANGED);
    hear("tasks://changed");
    hear("local-hub://changed");
    hear("monocode:delegations-changed");
    return () => {
      stopped = true;
      stop();
      for (const un of stops) un();
    };
  }, []);
  return needsYou(factsFromParts({
    remote,
    rows,
    projects: projects(),
    chats: safeChats(),
    pages: safePages(),
    delegations,
  }), Date.now());
}
