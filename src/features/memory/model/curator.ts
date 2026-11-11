// WP-51: after one first-mate turn, zero or one durable fact, or a skill the person still has to accept.
// A timeout is not a decision. A secret is never stored and never sent on.

import { isValidSkillName, slugSkillName } from "../../skills/model/skills";
import { bump, cleanEntities, emptyDoc, ENGINE_ID, FACT_KINDS, isDay, isForgotten, memoryId, mentionsSecret, normalizeFact, withoutForgotten, type FactKind, type MemoryDoc, type MemoryItem, type MemoryVia } from "./doc";
import { touch } from "./fade";
import { givesOrders } from "./orderScan";
import { withContradiction } from "./review";

/** Same sentence as skillLearn.plainLesson. Not imported: loading that module registers a change kind. */
function oneSentence(raw: string): string {
  const line = raw
    .replace(/\s+/g, " ")
    .replace(/^[-*•\d.\s]+/, "")
    .trim();
  return line.length > 400 ? `${line.slice(0, 397).trimEnd()}…` : line;
}

export type CuratorAsk =
  | { ok: true; text: string }
  | { ok: false; kind: "timeout" | "unreachable" | "refused"; reason: string };

export type CuratorOutcome =
  | { status: "none"; ignored: number }
  | { status: "deferred" }
  | { status: "stored"; ignored: number }
  | { status: "dropped"; reason: "late" | "secret" | "ungrounded" | "invalid" | "orders" | "forgotten"; ignored: number };

export type CuratorContext = {
  mateId: string;
  turnId: string;
  user: string;
  assistant: string;
  now: number;
  /** WP-100: the engine whose conversation this turn is (session.harness). Absent when unknown. */
  by?: string;
  /** WP-103: the tier answering this turn, so the memory it writes can say where it came from. */
  via?: MemoryVia;
};

/** WP-240: the typed details a curator may give with a new fact. Each is optional and checked on the way in. */
export type FactDetails = {
  kind?: FactKind;
  entities?: string[];
  occurredOn?: string;
  validFrom?: string;
  validTo?: string;
};

export type CuratorProposal = Proposal;

type Proposal =
  | { kind: "none" }
  | { kind: "add"; text: string; evidence: string; details?: FactDetails }
  | { kind: "update"; targetId: string; text: string; evidence: string }
  | { kind: "remove"; targetId: string; evidence: string }
  | { kind: "skill"; name: string; lesson: string; evidence: string };

export type CuratorAnswer =
  | { kind: "deferred" }
  | { kind: "already" }
  | { kind: "secret" }
  | { kind: "empty" }
  | { kind: "refused" }
  | { kind: "reply"; text: string };

const TARGET = /^mem-[a-f0-9]{16}$/;
const DONE_CAP = 2000;

function turnKey(ctx: CuratorContext): string {
  return `${ctx.mateId}:${ctx.turnId}`;
}

function markDone(doc: MemoryDoc, key: string): MemoryDoc {
  if (doc.doneTurns.includes(key)) return doc;
  return bump({ ...doc, doneTurns: [...doc.doneTurns, key].slice(-DONE_CAP) });
}

function cited(evidence: string, turn: string): boolean {
  const needle = normalizeFact(evidence).toLowerCase();
  if (needle.length < 3) return false;
  return normalizeFact(turn).toLowerCase().includes(needle);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function closeBrace(text: string, open: number): number {
  let depth = 0;
  let quote = false;
  let escape = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** One JSON object, an array, or several objects one after another. Prose around them is ignored. */
export function parseCuratorReply(text: string): Proposal[] {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) body = fence[1].trim();
  if (!body) return [];
  const whole = tryParse(body);
  const values = whole === undefined ? scanned(body) : Array.isArray(whole) ? whole : [whole];
  return values.flatMap((value) => {
    const proposal = asProposal(value);
    return proposal ? [proposal] : [];
  });
}

function scanned(body: string): unknown[] {
  const found: unknown[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "{") continue;
    const end = closeBrace(body, i);
    if (end < 0) continue;
    const value = tryParse(body.slice(i, end + 1));
    if (value !== undefined) {
      found.push(value);
      i = end;
    }
  }
  return found;
}

/** WP-240: the details a reply gave, each kept only when it can be read. Undefined when none survive. */
export function detailsOf(value: unknown): FactDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: FactDetails = {};
  if (FACT_KINDS.includes(raw.kind as FactKind)) out.kind = raw.kind as FactKind;
  const entities = cleanEntities(raw.entities);
  if (entities) out.entities = entities;
  for (const field of ["occurredOn", "validFrom", "validTo"] as const) {
    if (isDay(raw[field])) out[field] = raw[field];
  }
  return Object.keys(out).length ? out : undefined;
}

export function asProposal(value: unknown): Proposal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as { kind?: unknown; text?: unknown; evidence?: unknown; targetId?: unknown; name?: unknown; lesson?: unknown };
  const evidence = typeof raw.evidence === "string" ? raw.evidence : "";
  if (raw.kind === "none") return { kind: "none" };
  if (raw.kind === "add" && typeof raw.text === "string") {
    const details = detailsOf((value as { details?: unknown }).details);
    return details ? { kind: "add", text: raw.text, evidence, details } : { kind: "add", text: raw.text, evidence };
  }
  if (raw.kind === "update" && typeof raw.text === "string" && typeof raw.targetId === "string") {
    return { kind: "update", text: raw.text, targetId: raw.targetId, evidence };
  }
  if (raw.kind === "remove" && typeof raw.targetId === "string") return { kind: "remove", targetId: raw.targetId, evidence };
  if (raw.kind === "skill" && typeof raw.name === "string" && typeof raw.lesson === "string") {
    return { kind: "skill", name: raw.name, lesson: raw.lesson, evidence };
  }
  return undefined;
}

/**
 * WP-240: what a curator must not read into a person's words, and the optional details an add may carry. Hivra's own
 * wording; no prompt text was copied. (Idea: Nod by n8n, Apache-2.0, src/server/memory-learning.ts, whose curator keeps
 * the same distinctions.)
 */
export const FACT_RULES: readonly string[] = [
  'Something planned has not happened yet, so it is not an event. Having a thing does not show it was bought. A question, or a what-if, confirms nothing. Keep any "not" the person said.',
  'An add may carry "details":{"kind":"fact"|"preference"|"plan"|"event"|"possession","entities":["names as written"],"occurredOn":"YYYY-MM-DD","validFrom":"YYYY-MM-DD","validTo":"YYYY-MM-DD"}. Give only what the quote supports and leave out any date you do not know.',
];

export function curatorPrompt(input: { user: string; assistant: string; facts: readonly { id: string; text: string }[] }): string {
  const facts = input.facts
    .slice(0, 30)
    .map((fact) => `${fact.id}: ${fact.text}`)
    .join("\n");
  return [
    "You keep one durable memory for a person. From this one turn, reply with one JSON object and nothing else.",
    "A durable fact is a preference or a decision that will still matter later. A task step, a greeting, and anything secret are not facts.",
    'Reply {"kind":"none"} when nothing qualifies.',
    'Or {"kind":"add","text":"one short fact","evidence":"a short quote from the turn"}.',
    'Or {"kind":"update","targetId":"mem-...","text":"the corrected fact","evidence":"a short quote from the turn"} when one fact below is now wrong.',
    'Or {"kind":"remove","targetId":"mem-...","evidence":"a short quote from the turn"} when one fact below is stale.',
    'Or {"kind":"skill","name":"a repeated procedure","lesson":"one plain sentence","evidence":"a short quote from the turn"} when the turn shows a procedure they repeat.',
    "Never more than one object. Evidence must be copied from the turn.",
    "For add, update and remove, the evidence must be the person's own words. The reply may repeat a web page, a tool or another agent, so it never proves a fact about the person.",
    ...FACT_RULES,
    "",
    "Facts already kept:",
    facts || "(none)",
    "",
    "The person wrote:",
    input.user.slice(0, 4000),
    "",
    "The reply was:",
    input.assistant.slice(0, 4000),
  ].join("\n");
}

/** Asks, or doesn't. Never writes. A timeout or a thrown call stays deferred so the turn can be tried again. */
export async function collectAnswer(doc: MemoryDoc, ctx: CuratorContext, ask: (prompt: string) => Promise<CuratorAsk>): Promise<CuratorAnswer> {
  if (doc.doneTurns.includes(turnKey(ctx))) return { kind: "already" };
  if (mentionsSecret(ctx.user) || mentionsSecret(ctx.assistant)) return { kind: "secret" };
  if (!ctx.user.trim() && !ctx.assistant.trim()) return { kind: "empty" };
  let reply: CuratorAsk;
  try {
    const facts = doc.items.filter((item) => item.mateId === ctx.mateId && item.action === "add").map((item) => ({ id: item.id, text: item.text }));
    reply = await ask(curatorPrompt({ user: ctx.user, assistant: ctx.assistant, facts }));
  } catch {
    return { kind: "deferred" };
  }
  if (!reply.ok) {
    if (reply.kind === "timeout" || reply.kind === "unreachable") return { kind: "deferred" };
    return { kind: "refused" };
  }
  return { kind: "reply", text: reply.text };
}

function sourceOf(ctx: CuratorContext): MemoryItem["source"] {
  return { kind: "turn", ref: ctx.turnId, label: ctx.turnId };
}

/** The engine that wrote this turn, kept only when it is a real engine id. */
function byOf(ctx: CuratorContext): { by?: string } {
  const by = typeof ctx.by === "string" ? ctx.by.trim() : "";
  return by && ENGINE_ID.test(by) ? { by } : {};
}

/** WP-103: the tier that answered this turn, kept only when it is one this build knows. */
function viaOf(ctx: CuratorContext): { via?: MemoryVia } {
  return ctx.via === "rules" || ctx.via === "cheap" || ctx.via === "crew" ? { via: ctx.via } : {};
}

/**
 * WP-100: a fact the curator sees again in a later turn is a use, not a duplicate. The item it already has keeps
 * its row: its support grows by one and it is topped up (fade, lastUsedAt). A skill is not used this way, because a
 * repeated lesson is not the same as reading it.
 */
function repeatItem(doc: MemoryDoc, item: MemoryItem): MemoryDoc {
  return bump({
    ...doc,
    items: doc.items.map((have) =>
      // WP-240: support counts distinct messages, so the same message read twice is not a second mention.
      have.id !== item.id || (have.source.kind === item.source.kind && have.source.ref === item.source.ref)
        ? have
        : have.action === "skill"
          ? { ...have, support: have.support + 1 }
          : { ...touch(have, item.updatedAt), support: have.support + 1 },
    ),
  });
}

function addItem(doc: MemoryDoc, item: MemoryItem): { doc: MemoryDoc; outcome: CuratorOutcome } {
  if (doc.items.some((have) => have.id === item.id)) {
    return { doc: repeatItem(doc, item), outcome: { status: "stored", ignored: 0 } };
  }
  // WP-240: a fact said again after it was let go is kept again, and leaves the "Let go" list.
  const archived = doc.archived?.filter((have) => have.id !== item.id);
  const next: MemoryDoc = { ...doc, items: [...doc.items, item] };
  if (archived && archived.length !== doc.archived?.length) {
    if (archived.length) next.archived = archived;
    else delete next.archived;
  }
  return { doc: bump(next), outcome: { status: "stored", ignored: 0 } };
}

/** addItem only stores or drops. The ignored count is how many later proposals were not kept. */
function counted(
  stored: { doc: MemoryDoc; outcome: CuratorOutcome },
  ignored: number,
): { doc: MemoryDoc; outcome: CuratorOutcome } {
  if (stored.outcome.status === "dropped") {
    return { doc: stored.doc, outcome: { status: "dropped", reason: stored.outcome.reason, ignored } };
  }
  if (stored.outcome.status === "stored") {
    return { doc: stored.doc, outcome: { status: "stored", ignored } };
  }
  return stored;
}

/**
 * A fact the person deleted stays deleted when the cheap curator meets it again. Only the rules tier, which reads the
 * person's own "remember that ..." or correction, brings it back, and then the digest goes. Undefined means drop it.
 */
function unforgotten(doc: MemoryDoc, ctx: CuratorContext, text: string): MemoryDoc | undefined {
  if (!isForgotten(doc, ctx.mateId, text)) return doc;
  return ctx.via === "rules" ? withoutForgotten(doc, ctx.mateId, text) : undefined;
}

/** Applies at most the first proposal. A second one is ignored, not stored. */
export function settleTurn(doc: MemoryDoc, ctx: CuratorContext, answer: CuratorAnswer): { doc: MemoryDoc; outcome: CuratorOutcome } {
  const key = turnKey(ctx);
  if (answer.kind === "deferred") return { doc, outcome: { status: "deferred" } };
  if (answer.kind === "already" || doc.doneTurns.includes(key)) return { doc, outcome: { status: "none", ignored: 0 } };
  if (answer.kind === "secret") return { doc: markDone(doc, key), outcome: { status: "dropped", reason: "secret", ignored: 0 } };
  if (answer.kind === "empty") return { doc: markDone(doc, key), outcome: { status: "none", ignored: 0 } };
  if (answer.kind === "refused") return { doc: markDone(doc, key), outcome: { status: "dropped", reason: "invalid", ignored: 0 } };
  if (!answer.text.trim()) return { doc: markDone(doc, key), outcome: { status: "none", ignored: 0 } };

  const proposals = parseCuratorReply(answer.text);
  const chosen = proposals[0];
  const ignored = Math.max(0, proposals.length - 1);
  if (!chosen) return { doc: markDone(doc, key), outcome: { status: "dropped", reason: "invalid", ignored } };
  const judged = applyProposal(doc, ctx, chosen, ignored);
  return { doc: markDone(judged.doc, key), outcome: judged.outcome };
}

/**
 * WP-240: one proposal checked and, when it passes, stored. The turn is not marked done here: settleTurn does that for
 * a turn, and the batch curator moves its watermark instead. Every check a proposal passes lives here, so the
 * per-turn path and the batch path keep the same rules.
 */
export function applyProposal(
  doc: MemoryDoc,
  ctx: CuratorContext,
  chosen: CuratorProposal,
  ignored = 0,
): { doc: MemoryDoc; outcome: CuratorOutcome } {
  if (chosen.kind === "none") return { doc, outcome: { status: "none", ignored } };

  // A fact about the person is grounded only in the person's own words. The reply can repeat a web page, a tool's
  // output or another agent, and none of that may become a fact about them. A skill is a procedure the turn showed,
  // so its evidence may come from the reply too; it still waits for the person before it is used.
  // (Idea: Nod by n8n, Apache-2.0, src/server/memory-ops.ts applyOps keeps a note only when its quote is in a cited
  // owner message.)
  const grounds = chosen.kind === "skill" ? `${ctx.user}\n${ctx.assistant}` : ctx.user;
  if (!cited(chosen.evidence, grounds) || mentionsSecret(chosen.evidence)) {
    return { doc, outcome: { status: "dropped", reason: "ungrounded", ignored } };
  }

  if (chosen.kind === "add") {
    const text = normalizeFact(chosen.text);
    if (!text || mentionsSecret(text)) return { doc, outcome: { status: "dropped", reason: "secret", ignored } };
    // WP-111: instructions aimed at the model are not stored. What is already kept stays.
    if (givesOrders(text)) return { doc, outcome: { status: "dropped", reason: "orders", ignored } };
    const remembered = unforgotten(doc, ctx, text);
    if (!remembered) return { doc, outcome: { status: "dropped", reason: "forgotten", ignored } };
    doc = remembered;
    const item: MemoryItem = {
      id: memoryId([ctx.mateId, "add", text.toLowerCase()]),
      mateId: ctx.mateId,
      action: "add",
      text,
      ...byOf(ctx),
      ...viaOf(ctx),
      state: "unreviewed",
      source: sourceOf(ctx),
      evidence: normalizeFact(chosen.evidence),
      support: 1,
      against: 0,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      ...(chosen.details ?? {}),
    };
    // WP-111: a fact that disagrees with a confirmed one is parked beside it. Nothing is overwritten.
    const parked = withContradiction(doc, item);
    return counted(addItem(parked.doc, parked.item), ignored);
  }

  if (chosen.kind === "skill") {
    const name = slugSkillName(chosen.name);
    const lesson = oneSentence(chosen.lesson);
    if (!isValidSkillName(name) || !lesson || mentionsSecret(lesson) || mentionsSecret(name)) {
      return { doc, outcome: { status: "dropped", reason: mentionsSecret(lesson) ? "secret" : "invalid", ignored } };
    }
    if (givesOrders(lesson)) return { doc, outcome: { status: "dropped", reason: "orders", ignored } };
    const remembered = unforgotten(doc, ctx, lesson);
    if (!remembered) return { doc, outcome: { status: "dropped", reason: "forgotten", ignored } };
    doc = remembered;
    const item: MemoryItem = {
      id: memoryId([ctx.mateId, "skill", name, lesson.toLowerCase()]),
      mateId: ctx.mateId,
      action: "skill",
      text: lesson,
      skill: { name, lesson },
      ...byOf(ctx),
      ...viaOf(ctx),
      state: "unreviewed",
      source: sourceOf(ctx),
      evidence: normalizeFact(chosen.evidence),
      support: 1,
      against: 0,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    return counted(addItem(doc, item), ignored);
  }

  if (!TARGET.test(chosen.targetId)) {
    return { doc, outcome: { status: "dropped", reason: "invalid", ignored } };
  }
  const target = doc.items.find((item) => item.id === chosen.targetId && item.mateId === ctx.mateId && item.action === "add");
  if (!target) return { doc, outcome: { status: "dropped", reason: "invalid", ignored } };
  // A removal whose text matches is refused too, so the fact is not deleted from here.
  if (chosen.kind === "remove" && givesOrders(target.text)) {
    return { doc, outcome: { status: "dropped", reason: "orders", ignored } };
  }

  if (chosen.kind === "remove") {
    const item: MemoryItem = {
      id: memoryId([ctx.mateId, "remove", chosen.targetId]),
      mateId: ctx.mateId,
      action: "remove",
      text: target.text,
      targetId: chosen.targetId,
      ...byOf(ctx),
      ...viaOf(ctx),
      state: "unreviewed",
      source: sourceOf(ctx),
      evidence: normalizeFact(chosen.evidence),
      support: 0,
      against: 1,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    return counted(addItem(doc, item), ignored);
  }

  const text = normalizeFact(chosen.text);
  if (!text || mentionsSecret(text)) return { doc, outcome: { status: "dropped", reason: "secret", ignored } };
  if (givesOrders(text)) return { doc, outcome: { status: "dropped", reason: "orders", ignored } };
  const remembered = unforgotten(doc, ctx, text);
  if (!remembered) return { doc, outcome: { status: "dropped", reason: "forgotten", ignored } };
  doc = remembered;
  const item: MemoryItem = {
    id: memoryId([ctx.mateId, "update", chosen.targetId, text.toLowerCase()]),
    mateId: ctx.mateId,
    action: "update",
    text,
    targetId: chosen.targetId,
    ...byOf(ctx),
    ...viaOf(ctx),
    state: "unreviewed",
    source: sourceOf(ctx),
    evidence: normalizeFact(chosen.evidence),
    support: 1,
    against: 0,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  return counted(addItem(doc, item), ignored);
}

export async function curateTurn(
  doc: MemoryDoc,
  ctx: CuratorContext,
  ask: (prompt: string) => Promise<CuratorAsk>,
): Promise<{ doc: MemoryDoc; outcome: CuratorOutcome; answer: CuratorAnswer }> {
  const answer = await collectAnswer(doc, ctx, ask);
  if (answer.kind === "deferred") return { doc, outcome: { status: "deferred" }, answer };
  const settled = settleTurn(doc, ctx, answer);
  return { ...settled, answer };
}

/** The doc tests start from. */
export function freshDoc(): MemoryDoc {
  return emptyDoc();
}
