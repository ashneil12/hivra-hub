// Live facts for the one Needs you list. Worker rows come from needsYouRows, not a second worker list.
// A late read loses to a newer one. A timeout keeps the last good remote facts.
// Only useNeedsYou publishes the list. A quiet read (Home's opening count) must not replace it.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { projectKey } from "../../../shared/lib/paths";
import { DECISIONS_CHANGED, tauriFirstMate, type Decision } from "../../firstmate/model/steering";
import { foldDecisionKey, isPersonOnlyDecisionKey } from "../../hub/model/decisionKey";
import { useDelegationRows } from "../../monos/model/delegationStore";
import { findMono } from "../../monos/model/mono";
import { openFromHome } from "../../home/model/opener";
import { parseTask, taskReadKeys, type HomeDecision, type HomeProject, type HomeTask } from "../../home/model/lines";
import type { AskRow } from "../../hub/model/chatQuestions";
import { commonGitDir, gitdirFromGitFile, joinRepoPath, originUrlFromGitConfig, repoFromOriginUrl } from "./projectRepos";
import { allKeptPages, needsAllow, requestOpenPage, usePagesVersion, type Page } from "../../pages/model/pages";
import { PR_WATCHES_CHANGED, tauriPrWatches, type PrWatch } from "../../pr-watch/model/prWatches";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import {
  answerApproval,
  answerPermission,
  answerRow,
  approvalMessage,
  openRows,
  openWaitingChat,
  takePick,
  useWaitingChatsVersion,
  waitingChats,
  type WaitingChat,
} from "../../hub/model/waitingChats";
import { currentNeedsYouRows, useNeedsYouRows } from "../../hub/model/useNeedsYouRows";
import type { NeedsYouRow } from "../../hub/model/needsYouRows";
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

export type ProjectRef = { id: string; name: string; folder: string | null; origin?: string | null };

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

function isErrand(chat: WaitingChat): boolean {
  return Boolean(chat.provide?.trim()) || chat.flag === "provide";
}

/** One row of a card. A red-line row and a pick answer that row, never the whole card. */
function rowFact(chat: WaitingChat, row: AskRow, id: string): QuestionFact | ApprovalFact {
  const base = {
    id,
    projectId: chat.projectId ?? undefined,
    monoId: chat.monoId,
    who: chat.chatName || "Coding team",
    at: chat.askedAt,
    sentence: row.question,
    open: { where: "chat" as const, id: chat.sessionId },
    onOpen: () => openWaitingChat(chat.sessionId),
    routedToLead: chat.routedToLead,
    sessionId: chat.sessionId,
  };
  if (isErrand(chat)) return base;
  if (accessAsk(row.question)) return { ...base, reviewOnly: true };
  const pick = row.pick?.trim() ?? "";
  const seen = { requestId: chat.requestId, question: row.question, pick: row.pick ?? null };
  if (row.redLine) {
    if (pick && pick !== row.question.trim()) return base;
    return {
      ...base,
      risky: true,
      allowLabel: "Approve once",
      onAllow: () => { void answerRow(chat.sessionId, row, approvalMessage("approve-once", row), "words", seen); },
      onDeny: () => { void answerRow(chat.sessionId, row, approvalMessage("deny", row), "words", seen); },
    };
  }
  if (!pick) return base;
  const shown = pickButton(pick);
  return {
    ...base,
    ...shown,
    onAnswer: () => { void answerRow(chat.sessionId, row, pick, "pick", seen); },
  };
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
    sessionId: chat.sessionId,
  };
  if (isErrand(chat)) return base;
  if (accessAsk(question)) return { ...base, reviewOnly: true };
  if (chat.source === "permission") {
    const seen = { requestId: chat.requestId, question: chat.question };
    return {
      ...base,
      onAllow: () => { answerPermission(chat.sessionId, "allow", seen); },
      onDeny: () => { answerPermission(chat.sessionId, "deny", seen); },
    };
  }
  const pick = chat.pick?.trim() ?? "";
  if (chat.redLine || chat.gate?.kind === "approval") {
    if (pick && pick !== question.trim()) return base;
    const seen = { question: chat.question, askedAt: chat.askedAt, pick: chat.pick };
    return {
      ...base,
      ...(chat.redLine ? { risky: true } : {}),
      onAllow: () => { void answerApproval(chat.sessionId, "approve-once", seen); },
      onDeny: () => { void answerApproval(chat.sessionId, "deny", seen); },
    };
  }
  if (!pick) return base;
  return {
    ...base,
    ...pickButton(pick),
    onAnswer: () => { void takePick(chat.sessionId, { by: "ash", seen: { requestId: chat.requestId, question: chat.question, pick: chat.pick ?? null } }); },
  };
}

/** The button is the pick. A long pick is shortened; the full text stays on the button. */
function pickButton(pick: string): { answerLabel: string; answerTitle: string } {
  const full = pick.replace(/\s+/g, " ").trim();
  const label = full.length > 80 ? `${full.slice(0, 77).trimEnd()}...` : full;
  return { answerLabel: label, answerTitle: full };
}

function keepFact(fact: QuestionFact | ApprovalFact, questions: QuestionFact[], approvals: ApprovalFact[]) {
  if (("reviewOnly" in fact && fact.reviewOnly) || ("onAllow" in fact && fact.onAllow)) approvals.push(fact);
  else questions.push(fact);
}

/** Chat questions and permission asks, one fact per open row. A merge stays a question so the decision wins. */
export function factsFromChats(chats: readonly WaitingChat[]): { questions: QuestionFact[]; approvals: ApprovalFact[] } {
  const questions: QuestionFact[] = [];
  const approvals: ApprovalFact[] = [];
  for (const chat of chats) {
    const rows = openRows(chat);
    if (rows.length) {
      for (const row of rows) {
        if (!row.question.trim()) continue;
        // The question id, or the question itself. Never the row's place, which moves as rows are answered.
        keepFact(rowFact(chat, row, `${chat.sessionId}:${row.questionId ?? row.question}`), questions, approvals);
      }
      continue;
    }
    if (!chat.question.trim()) continue;
    keepFact(rowFacts(chat, chat.question, chat.sessionId), questions, approvals);
  }
  return { questions, approvals };
}

/** The recommended option, when it is one of the options. Never the first option, and never a guessed Yes. */
function namedOption(decision: Decision): string | undefined {
  const recommended = decision.recommended?.trim();
  if (!recommended || !decision.options.includes(recommended)) return undefined;
  return recommended;
}

function sendOption(decision: Decision, option: string): () => void {
  return () => { void tauriFirstMate.answer(decision.project, decision.decisionKey, option); };
}

function openDecision(decision: Decision, projectId: string | undefined): () => void {
  return () => openFromHome({ kind: "inbox", projectId: projectId ?? "", decisionKey: decision.decisionKey });
}

const ALLOW_WORDS = ["Allow always", "Allow once", "Allow"];

function approvalDecision(
  decision: Decision,
  base: { id: string; projectId?: string; monoId?: string; who: string; at: number; sentence: string; decisionKey: string },
  named: string | undefined,
  open: () => void,
): ApprovalFact {
  const literal = decision.options.find((option) => ALLOW_WORDS.includes(option));
  if (literal) {
    const primary = named && ALLOW_WORDS.includes(named) ? named : literal;
    const second = decision.options.find((option) => option !== primary);
    return {
      ...base,
      allowLabel: primary,
      onAllow: sendOption(decision, primary),
      ...(second ? { denyLabel: second, onDeny: sendOption(decision, second) } : { onOpen: open }),
    };
  }
  if (decision.options.includes("Yes") || decision.options.includes("No")) {
    const yes = decision.options.includes("Yes");
    const no = decision.options.includes("No");
    return {
      ...base,
      ...(yes ? { onAllow: sendOption(decision, "Yes") } : { onOpen: open }),
      ...(no ? { onDeny: sendOption(decision, "No") } : {}),
    };
  }
  if (named) {
    const second = decision.options.find((option) => option !== named);
    return {
      ...base,
      allowLabel: named,
      onAllow: sendOption(decision, named),
      ...(second ? { denyLabel: second, onDeny: sendOption(decision, second) } : { onOpen: open }),
    };
  }
  return { ...base, onOpen: open };
}

function mergeDecision(
  decision: Decision,
  base: { id: string; projectId?: string; monoId?: string; who: string; at: number; sentence: string; decisionKey: string },
  named: string | undefined,
  other: string | undefined,
  open: () => void,
): QuestionFact {
  const askedBy = decision.askedBy;
  const hasMerge = decision.options.includes("Merge");
  const hasNotYet = decision.options.includes("Not yet");
  if (hasMerge || hasNotYet) {
    return {
      ...base,
      fromDecision: true,
      askedBy,
      asMerge: true,
      ...(hasMerge ? { onAnswer: sendOption(decision, "Merge") } : {}),
      ...(hasNotYet ? { onNotYet: sendOption(decision, "Not yet") } : {}),
      ...(!hasMerge ? { onOpen: open } : {}),
    };
  }
  if (decision.options.includes("Yes") || decision.options.includes("No")) {
    const yes = decision.options.includes("Yes");
    const no = decision.options.includes("No");
    return {
      ...base,
      fromDecision: true,
      askedBy,
      asMerge: true,
      ...(yes ? { onAnswer: sendOption(decision, "Yes") } : { onOpen: open }),
      ...(no ? { onNotYet: sendOption(decision, "No") } : {}),
    };
  }
  if (named) {
    return {
      ...base,
      fromDecision: true,
      askedBy,
      answerLabel: named,
      answerTitle: named,
      onAnswer: sendOption(decision, named),
      ...(other ? { onNotYet: sendOption(decision, other), otherLabel: other } : { onOpen: open }),
    };
  }
  return { ...base, fromDecision: true, askedBy, onOpen: open };
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
    const named = namedOption(decision);
    const other = named ? decision.options.find((option) => option !== named) : undefined;
    const open = openDecision(decision, base.projectId);
    const askedBy = decision.askedBy;
    if (isPersonOnlyDecisionKey(decision.decisionKey)) {
      questions.push(parked.has(decision.decisionKey)
        ? { ...base, fromDecision: true, askedBy, gateKey: decision.decisionKey, onOpen: open }
        : { ...base, fromDecision: true, askedBy, onOpen: open });
      continue;
    }
    if (parked.has(decision.decisionKey)) {
      questions.push({
        ...base,
        fromDecision: true,
        askedBy,
        gateKey: decision.decisionKey,
        onOpen: open,
      });
      continue;
    }
    if (accessAsk(decision.question)) {
      approvals.push({ ...base, reviewOnly: true, onOpen: open });
      continue;
    }
    if (APPROVAL_PHRASE.test(decision.question)) {
      approvals.push(approvalDecision(decision, base, named, open));
      continue;
    }
    const merge = MERGE_PHRASE.test(decision.question);
    if (merge) {
      questions.push(mergeDecision(decision, base, named, other, open));
      continue;
    }
    if (named) {
      questions.push({
        ...base,
        fromDecision: true,
        askedBy,
        answerLabel: named,
        answerTitle: named,
        onAnswer: sendOption(decision, named),
        onOpen: open,
      });
      continue;
    }
    questions.push({ ...base, fromDecision: true, askedBy, onOpen: open });
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

function cardFacts(cards: readonly GateCard[], list: readonly ProjectRef[], decisions: readonly Decision[]): CheckFact[] {
  const closed = new Set(decisions.filter((decision) => decision.state !== "open" && decision.decisionKey.trim()).map((decision) => foldDecisionKey(decision.decisionKey)));
  return cards.flatMap((card) => {
    if (card.state !== "parked" || !card.decisionKey || !card.line.trim()) return [];
    const key = card.decisionKey;
    if (closed.has(foldDecisionKey(key))) return [];
    const respond = (answer: "Approve" | "Fix") => {
      void invoke("gate_respond", { decisionKey: key, answer, project: card.projectId }).finally(() => { void refreshNeedsRemote(); });
    };
    return [{
      id: card.id,
      gateKey: key,
      projectId: projectIdOf(card.projectId, list),
      who: "Coding team",
      at: 0,
      sentence: card.line,
      onApprove: () => respond("Approve"),
      onFix: () => respond("Fix"),
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

function ownedRepos(list: readonly ProjectRef[]): Set<string> {
  const repos = new Set<string>();
  for (const project of list) {
    const named = repoFromOriginUrl(project.origin);
    if (named) repos.add(named);
    const cached = repoByProject.get(project.id);
    if (cached) repos.add(cached);
  }
  return repos;
}

/** Each project's own origin. A review is compared with this, not with every repo in the set. */
function originsByProject(list: readonly ProjectRef[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const project of list) {
    const named = repoByProject.get(project.id) ?? repoFromOriginUrl(project.origin);
    if (named) map.set(project.id, named);
  }
  return map;
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

let liveTasks: readonly HomeTask[] = [];
const repoByProject = new Map<string, string>();

/**
 * Home's decisions and tasks, plus the chats, pages and stopped workers already waiting.
 * `live` is a quiet read of gate cards and pull-request watches. Absent, the last published read stands.
 * A chat store that throws adds nothing.
 */
export function factsFromHome(
  decisions: readonly HomeDecision[],
  tasks: readonly HomeTask[],
  homeProjects: readonly HomeProject[],
  live?: { cards?: readonly GateCard[]; watches?: readonly PrWatch[] },
): NeedsSources {
  const list = homeProjects.map((project) => ({ id: project.id, name: project.name, folder: project.folder }));
  const fromDecisions = decisionFacts(decisions.map(homeDecision), list, new Set());
  const fromTasks = taskFacts(tasks, list);
  const chats = factsFromChats(safeChats());
  const cards = live?.cards ?? remote.cards;
  const watches = live?.watches ?? remote.watches;
  return {
    stopped: stoppedFacts(currentNeedsYouRows()),
    questions: [...fromDecisions.questions, ...fromTasks.questions, ...chats.questions],
    approvals: [...fromDecisions.approvals, ...chats.approvals, ...pageFacts(safePages(), list)],
    reviews: [...fromTasks.reviews, ...watchFacts(watches, list)],
    checks: cardFacts(cards, list, decisions.map(homeDecision)),
    knownProjects: new Set(list.map((project) => project.id)),
    ownRepos: ownedRepos(list),
    ownRepoByProject: originsByProject(list),
  };
}

export type NeedsParts = {
  remote: RemoteNeeds;
  rows: readonly NeedsYouRow[];
  projects: readonly ProjectRef[];
  chats: readonly WaitingChat[];
  pages: readonly Page[];
  delegations: readonly NeedsDelegation[];
  /** Absent means the tasks the live list is holding. */
  tasks?: readonly HomeTask[];
};

function tasksFor(parts: NeedsParts): readonly HomeTask[] {
  return parts.tasks ?? liveTasks;
}

/** One read of every source. Callers pass what they already hold, so a test never needs the live stores. */
export function factsFromParts(parts: NeedsParts): NeedsSources {
  const list = parts.projects;
  const parked = new Set(parts.remote.cards.filter((card) => card.state === "parked" && card.decisionKey).map((card) => card.decisionKey as string));
  const decisions = decisionFacts(parts.remote.decisions, list, parked);
  const chats = factsFromChats(parts.chats);
  const tasks = taskFacts(tasksFor(parts), list);
  return {
    stopped: stoppedFacts(parts.rows),
    questions: [...decisions.questions, ...tasks.questions, ...chats.questions],
    approvals: [...decisions.approvals, ...chats.approvals, ...pageFacts(parts.pages, list)],
    reviews: [...tasks.reviews, ...watchFacts(parts.remote.watches, list)],
    checks: cardFacts(parts.remote.cards, list, parts.remote.decisions),
    running: runningFacts(parts.delegations, list),
    ownRepos: ownedRepos(list),
    ownRepoByProject: originsByProject(list),
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

function publishRemote(next: RemoteNeeds, force = false) {
  if (!force && next === remote) return;
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

function sameTasks(left: readonly HomeTask[], right: readonly HomeTask[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((task, index) => {
    const other = right[index];
    return other != null
      && task.id === other.id
      && task.projectId === other.projectId
      && task.title === other.title
      && task.status === other.status
      && task.needsYou === other.needsYou
      && task.trashedAt === other.trashedAt;
  });
}

async function readLiveTasks(list: readonly ProjectRef[]): Promise<readonly HomeTask[] | undefined> {
  const keys = taskReadKeys(list.map((project) => ({ id: project.id, name: project.name, folder: project.folder })));
  if (keys.length === 0) return [];
  const reads = await Promise.all(keys.map((key) => orUndefined(invoke("tasks_list", { actor: { id: "person", project: key, kind: "person" } }))));
  if (reads.every((row) => row === undefined)) return undefined;
  const tasks: HomeTask[] = [];
  const seen = new Set<string>();
  for (const raw of reads) {
    if (!Array.isArray(raw)) continue;
    for (const row of raw) {
      const task = parseTask(row);
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);
      tasks.push(task);
    }
  }
  return tasks;
}

async function readGitText(path: string): Promise<string | undefined> {
  const chunks: string[] = [];
  for (let start = 1; start <= 37; start += 12) {
    let lines: unknown;
    try {
      lines = await invoke("read_file_preview", { path, maxLines: 12, startLine: start });
    } catch {
      return undefined;
    }
    if (!Array.isArray(lines)) return undefined;
    const text = lines.filter((line): line is string => typeof line === "string");
    chunks.push(...text);
    if (text.length < 12) break;
  }
  return chunks.join("\n");
}

/** A repo name, null when the folder was read and has no origin, undefined when the read failed. */
async function originOfFolder(folder: string): Promise<string | null | undefined> {
  const pointer = await readGitText(joinRepoPath(folder, ".git"));
  const gitdir = pointer !== undefined ? gitdirFromGitFile(pointer) : undefined;
  if (gitdir) {
    const resolved = joinRepoPath(folder, gitdir);
    const commonText = await readGitText(joinRepoPath(resolved, "commondir"));
    if (commonText === undefined) return undefined;
    const common = commonGitDir(resolved, commonText);
    if (!common) return null;
    const linked = await readGitText(joinRepoPath(common, "config"));
    if (linked === undefined) return undefined;
    return repoFromOriginUrl(originUrlFromGitConfig(linked)) ?? null;
  }
  const config = await readGitText(joinRepoPath(folder, ".git/config"));
  if (config !== undefined) return repoFromOriginUrl(originUrlFromGitConfig(config)) ?? null;
  if (pointer === undefined) return undefined;
  return null;
}

async function readOrigins(list: readonly ProjectRef[]): Promise<{ id: string; repo: string | null | undefined }[]> {
  return Promise.all(list.map(async (project) => {
    const folder = project.folder?.trim();
    if (!folder) return { id: project.id, repo: null };
    return { id: project.id, repo: await originOfFolder(folder) };
  }));
}

function applyTasks(tasks: readonly HomeTask[] | undefined): boolean {
  if (tasks === undefined || sameTasks(liveTasks, tasks)) return false;
  liveTasks = tasks;
  return true;
}

function applyOrigins(reads: readonly { id: string; repo: string | null | undefined }[]): boolean {
  let changed = false;
  for (const read of reads) {
    if (read.repo === undefined) continue;
    if (read.repo === null) {
      if (repoByProject.delete(read.id)) changed = true;
      continue;
    }
    if (repoByProject.get(read.id) !== read.repo) {
      repoByProject.set(read.id, read.repo);
      changed = true;
    }
  }
  return changed;
}

/**
 * Gate cards and pull-request watches for a quiet count. A failed read keeps the last good one.
 * This does not publish, so the list on screen stays as it is.
 */
export async function readQuietRemote(list: readonly ProjectRef[]): Promise<{ cards: GateCard[]; watches: PrWatch[] }> {
  const [watchesRaw, ...cardReads] = await Promise.all([
    orUndefined(tauriPrWatches.list()),
    ...list.map(async (project) => {
      const folder = project.folder?.trim() || project.id;
      return { projectId: folder, got: await orUndefined(invoke("gate_cards", { project: folder })) };
    }),
  ]);
  const cards = cardsAfter(remote.cards, cardReads) ?? [...remote.cards];
  const watches = watchesRaw === undefined ? remote.watches : (Array.isArray(watchesRaw) ? watchesRaw.map(asWatch).filter((row): row is PrWatch => row != null) : []);
  return { cards, watches };
}

/** Reload decisions, gate cards, pull-request watches, tasks and each project's origin. A timeout keeps the last good read. */
export async function refreshNeedsRemote(): Promise<void> {
  const mine = ++remoteGen;
  const list = projects();
  const [decisionsRaw, watchesRaw, taskRead, originReads, ...cardReads] = await Promise.all([
    orUndefined(tauriFirstMate.decisions(0)),
    orUndefined(tauriPrWatches.list()),
    readLiveTasks(list),
    readOrigins(list),
    ...list.map(async (project) => {
      const folder = project.folder?.trim() || project.id;
      return { projectId: folder, got: await orUndefined(invoke("gate_cards", { project: folder })) };
    }),
  ]);
  if (mine !== remoteGen) return;
  const tasksChanged = applyTasks(taskRead);
  const originsChanged = applyOrigins(originReads);
  const decisions = decisionsRaw === undefined ? undefined : (Array.isArray(decisionsRaw) ? decisionsRaw.map(asDecision).filter((row): row is Decision => row != null) : []);
  const watches = watchesRaw === undefined ? undefined : (Array.isArray(watchesRaw) ? watchesRaw.map(asWatch).filter((row): row is PrWatch => row != null) : []);
  const cards = cardsAfter(remote.cards, cardReads);
  const patch = decisions === undefined && watches === undefined && cards === undefined
    ? undefined
    : { decisions, watches, cards };
  const next = takeLatest(mine, remoteGen, patch === undefined ? undefined : mergeRemote(remote, patch), remote);
  publishRemote(next, tasksChanged || originsChanged);
}

function subscribeRemote(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let subscribers = 0;
let listenGeneration = 0;
let stopListens: (() => void) | undefined;

function startListens() {
  const mine = ++listenGeneration;
  const stops: Array<() => void> = [];
  let cancelled = false;
  const refresh = () => { void refreshNeedsRemote(); };
  refresh();
  const hear = (name: string) => {
    void listen(name, refresh).then((un) => {
      if (cancelled || mine !== listenGeneration) un();
      else stops.push(un);
    }, () => undefined);
  };
  hear(DECISIONS_CHANGED);
  hear(PR_WATCHES_CHANGED);
  hear("tasks://changed");
  hear("local-hub://changed");
  hear("monocode:delegations-changed");
  stopListens = () => {
    cancelled = true;
    for (const un of stops) un();
    stops.length = 0;
  };
}

export function resetNeedsLiveForTest(): void {
  remote = EMPTY_REMOTE;
  remoteGen = 0;
  listeners.clear();
  liveTasks = [];
  repoByProject.clear();
  listenGeneration += 1;
  stopListens?.();
  stopListens = undefined;
  subscribers = 0;
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
    subscribers += 1;
    if (subscribers === 1) startListens();
    return () => {
      stopped = true;
      stop();
      subscribers -= 1;
      if (subscribers === 0) {
        listenGeneration += 1;
        stopListens?.();
        stopListens = undefined;
      }
    };
  }, []);
  return needsYou(factsFromParts({
    remote,
    rows,
    projects: projects(),
    chats: safeChats(),
    pages: safePages(),
    delegations,
    tasks: liveTasks,
  }), Date.now());
}
