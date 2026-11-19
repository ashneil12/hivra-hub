// WP-243: a yes runs that exact action, once.
//
// When a CLI asks to run a tool, the app freezes the action: the tool's name and its full arguments, hashed (SHA-256 of
// a canonical JSON, keys sorted). The card carries the hash, and an Allow is bound to it: the registry (registry.ts)
// sends an allow only when the hash the answer names is the hash of the request still waiting under that id. A retry
// with different arguments is a new request with a new hash, so it is asked again; an answer for a card from an older
// process (request ids start again at 1 after a restart) can't land on a newer, different call; and once an allow is
// sent the record is gone, so a second allow for the same id does nothing.
//
// Claude (claude.ts) hashes the raw input it will hand back with the allow, and hashes it again just before it does: a
// changed input is denied. A CLI that says less about its call is hashed from everything the app was shown (its title,
// kind, call and preview), which is still what the card showed and the answer binds to.
//
// Nod (n8n, Apache-2.0, src/server/approvals.ts) gave the idea of running the exact approved payload once; no code is
// copied here.

import { sha256Hex } from "../../historyImport/model/hash";
import type { Block, CoveredBy } from "./session";

/** JSON with every object's keys sorted, so the same arguments always hash the same. Non-JSON values read as null. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) return '"…"';
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

/** The frozen action: the tool's name plus its full arguments, hashed. */
export function actionHash(tool: string, args: unknown): string {
  return sha256Hex(canonicalJson({ tool, args: args ?? null }));
}

/** What a CLI's approval request showed, for one that doesn't hand the app its raw arguments. */
export function shownActionHash(event: {
  title?: unknown;
  kind?: unknown;
  call?: unknown;
  preview?: unknown;
  child?: unknown;
}): string {
  return actionHash("shown", {
    title: event.title ?? null,
    kind: event.kind ?? null,
    call: event.call ?? null,
    preview: event.preview ?? null,
    child: event.child ?? null,
  });
}

/** The first characters of a hash, as the card shows it. */
export function shortHash(hash: string | undefined): string {
  return typeof hash === "string" ? hash.slice(0, 8) : "";
}

// ---- the ledger of open asks, per chat --------------------------------------------------------------------------------

const asked = new Map<string, Map<number, string>>();

/** A CLI asked: remember the frozen action under its request id. */
export function noteAsked(sessionId: string, requestId: number, hash: string): void {
  let chat = asked.get(sessionId);
  if (!chat) asked.set(sessionId, (chat = new Map()));
  chat.set(requestId, hash);
}

/** The ask is settled (answered, cancelled, or the turn ended): nothing can be allowed under that id any more. */
export function forgetAsked(sessionId: string, requestId: number): void {
  const chat = asked.get(sessionId);
  if (!chat) return;
  chat.delete(requestId);
  if (!chat.size) asked.delete(sessionId);
}

/** Drop every open ask of a chat (its CLI process went away). */
export function forgetChatAsks(sessionId: string): void {
  asked.delete(sessionId);
}

export type AllowCheck = { ok: true } | { ok: false; reason: "missing" | "mismatch" | "unbound" };

/**
 * Whether an allow may go to the CLI for this request. It must name the hash the card showed, and that must be the hash
 * of the request still waiting. Anything else is refused, and the card stays (fail closed).
 */
export function checkAllow(sessionId: string, requestId: number, hash: string | undefined): AllowCheck {
  const waiting = asked.get(sessionId)?.get(requestId);
  if (waiting === undefined) return { ok: false, reason: "missing" };
  if (typeof hash !== "string" || !hash) return { ok: false, reason: "unbound" };
  return waiting === hash ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** The hash of the card still open in a chat under this request id, if any. */
export function openActionHash(blocks: readonly Block[] | undefined, requestId: number): string | undefined {
  if (!blocks) return undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const approval = blocks[i]?.approval;
    if (approval && approval.requestId === requestId && !approval.decided) return approval.actionHash;
  }
  return undefined;
}

/** The line a card the app allowed on Ash's own words shows ("Because you said …"). */
export function coveredByLine(by: CoveredBy): string {
  const where = by.source === "message" ? "you said" : by.source === "rule" ? "your standing answer says" : "the routine says";
  return `Allowed because ${where} “${by.quote}”.`;
}

/** The line under a call a restart cut while it may have been running (inFlight.ts marks it). */
export const UNCERTAIN_LINE = "A restart cut this while it may have been running. It won't run again by itself.";

/** Tests only. */
export function resetAskedForTests(): void {
  asked.clear();
}
