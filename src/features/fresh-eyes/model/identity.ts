// WP-144: which brief a review is about. A decision on a review only counts for the brief that was reviewed, asked
// by the chat that asked: any other brief under the same request ID is a new review.

import { sha256Hex } from "../../historyImport/model/hash";

/** JSON with every object's keys sorted, so two calls with the same content are the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const row = value as Record<string, unknown>;
  const parts = Object.keys(row)
    .filter((key) => row[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`);
  return `{${parts.join(",")}}`;
}

/** The hash of the brief as it will start (the delegate call) and the chat that asked. */
export function briefHash(owner: string, held: Record<string, unknown> | undefined): string {
  return sha256Hex(canonicalJson({ owner: owner.trim(), held: held ?? null }));
}

/**
 * The Inbox key of one brief's question. It names the request, and carries a hash of the chat, the request and the
 * brief, so a reused request ID (or an edited brief under it) is a new question and never inherits an old answer.
 */
export function decisionKeyFor(requestId: string, owner: string, hash: string): string {
  const tag = sha256Hex(`${owner.trim()}\n${requestId}\n${hash}`).slice(0, 16);
  return `fresh-eyes/${requestId.slice(0, 60)}/${tag}`;
}

/**
 * The key of the question that says an approved brief could not start. Each give-up is its own question (`round`), so
 * one the person already answered ("Try again") is never taken for the answer to the next.
 */
export function startKeyFor(requestId: string, owner: string, hash: string, round: number): string {
  const tag = sha256Hex(`${owner.trim()}\n${requestId}\n${hash}\n${round}`).slice(0, 16);
  return `fresh-eyes-start/${requestId.slice(0, 60)}/${tag}`;
}
