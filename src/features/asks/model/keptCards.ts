// The one chat's app cards survive a save and a relaunch: the chat store keeps only the fields it knows
// (sessions/data/sessionStore.ts sanitizeBlock), so each card is checked and copied here. Without this a catch-up card,
// a "You messaged …" line or a Needs you roll-up came back as a bare grey line, folded into the work above, and the next
// catch-up lost where the last one ended.
import type { CatchUp, CatchUpDecision, CatchUpJob, CatchUpNeed } from "./catchUp";
import type { BesideMessage } from "./besideChat";
import type { RollupCard } from "../../needs/model/needsRollup";
import type { Block } from "../../sessions/model/session";

const ROWS_MAX = 50;
const TEXT_MAX = 2_000;

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => !!value && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const count = (value: unknown): number => Math.max(0, Math.floor(num(value) ?? 0));
const str = (value: unknown): string | undefined => (typeof value === "string" ? value.slice(0, TEXT_MAX) : undefined);
const text = (value: unknown): string | undefined => {
  const kept = str(value);
  return kept?.trim() ? kept : undefined;
};

function optional<T extends Loose>(row: T): T {
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
  return row;
}

function rows<T>(value: unknown, one: (row: Loose) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const kept: T[] = [];
  for (const row of value.slice(0, ROWS_MAX)) {
    const next = isObject(row) ? one(row) : undefined;
    if (next) kept.push(next);
  }
  return kept;
}

export function keptCatchUp(value: unknown): CatchUp | undefined {
  if (!isObject(value)) return undefined;
  const since = num(value.since);
  const at = num(value.at);
  if (since === undefined || at === undefined) return undefined;
  const finished = rows<CatchUpJob>(value.finished, (row) => {
    const id = text(row.id);
    const title = text(row.title);
    if (!id || !title || typeof row.ok !== "boolean") return undefined;
    return optional({ id, title, ok: row.ok, project: str(row.project), projectId: str(row.projectId), chat: str(row.chat), line: str(row.line) });
  });
  const decided = rows<CatchUpDecision>(value.decided, (row) => {
    const key = text(row.key);
    const question = text(row.question);
    const answer = str(row.answer);
    if (!key || !question || answer === undefined) return undefined;
    return optional({ key, question, answer, project: str(row.project), projectId: str(row.projectId), why: str(row.why) });
  });
  const needs = rows<CatchUpNeed>(value.needs, (row) => {
    const key = text(row.key);
    const sentence = text(row.sentence);
    if (!key || !sentence) return undefined;
    return optional({ key, sentence, project: str(row.project), projectId: str(row.projectId), who: str(row.who) });
  });
  return {
    since,
    at,
    finished,
    finishedMore: count(value.finishedMore),
    decided,
    decidedMore: count(value.decidedMore),
    needs,
    needsMore: count(value.needsMore),
    running: count(value.running),
  };
}

export function keptBesideMessage(value: unknown): BesideMessage | undefined {
  if (!isObject(value)) return undefined;
  const chatId = text(value.chatId);
  const to = text(value.to);
  const said = str(value.text);
  const at = num(value.at);
  return chatId && to && said !== undefined && at !== undefined ? { chatId, to, text: said, at } : undefined;
}

export function keptRollup(value: unknown): RollupCard | undefined {
  if (!isObject(value)) return undefined;
  const items = rows<RollupCard["items"][number]>(value.items, (row) => {
    const key = text(row.key);
    const sentence = text(row.sentence);
    if (!key || !sentence) return undefined;
    return optional({ key, sentence, where: str(row.where), projectId: text(row.projectId), yours: row.yours === true });
  });
  return items.length ? { items, more: count(value.more) } : undefined;
}

/** The one chat's cards on a system block, and the project filter's mark on his message, checked, to copy onto the block the store keeps. */
export function keptCards(
  block: Pick<Block, "role" | "catchUp" | "besideMessage" | "needsRollup" | "lensProject">,
): Pick<Block, "catchUp" | "besideMessage" | "needsRollup" | "lensProject"> {
  if (block.role === "user") {
    const lensProject = text(block.lensProject)?.slice(0, 200);
    return lensProject ? { lensProject } : {};
  }
  if (block.role !== "system") return {};
  const catchUp = keptCatchUp(block.catchUp);
  const besideMessage = keptBesideMessage(block.besideMessage);
  const needsRollup = keptRollup(block.needsRollup);
  return { ...(catchUp ? { catchUp } : {}), ...(besideMessage ? { besideMessage } : {}), ...(needsRollup ? { needsRollup } : {}) };
}
