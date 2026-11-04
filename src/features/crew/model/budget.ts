// Translated from Puppetmaster puppetmaster/failure_policy.py (MIT).
// Copyright (c) 2026 Cary
//
// Python became TypeScript. Integers stay type-strict: a boolean is never a retry count.

export type FailurePolicy = {
  action: "abort" | "continue" | "retry";
  retries: number;
  allowRoutingChange: boolean;
};

export type PolicyResult = { ok: true; policy: FailurePolicy } | { ok: false; error: string };

const RETRY = /^retry\(([0-9]+)\)$/;
const ACTIONS = new Set(["abort", "continue", "retry"]);

function policy(action: FailurePolicy["action"], retries = 0, allowRoutingChange = false): FailurePolicy {
  return { action, retries, allowRoutingChange };
}

/**
 * Validate `retry(n)`, abort, continue, or `{ action, retries }`.
 * `retries` must be a real integer from 0 to 10. `true` is not 1.
 */
export function normalizeFailurePolicy(value: unknown): PolicyResult {
  if (value == null) return { ok: false, error: "on_fail must be a string or object" };
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (raw === "abort" || raw === "continue") return { ok: true, policy: policy(raw) };
    const match = RETRY.exec(raw);
    if (match) {
      const count = Number(match[1]);
      if (count > 10) return { ok: false, error: "failure policy retries must be between 0 and 10" };
      return { ok: true, policy: policy("retry", count) };
    }
    return { ok: false, error: "on_fail must be abort, continue, or retry(n)" };
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 10) {
      return { ok: false, error: "failure policy retries must be an integer between 0 and 10" };
    }
    return { ok: true, policy: policy("retry", value) };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "on_fail must be a string or object" };
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !["action", "retries", "allow_routing_change"].includes(key));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown on_fail field(s): ${unknown.sort().join(", ")}` };
  }
  const actionRaw = record.action;
  if (typeof actionRaw !== "string" || !ACTIONS.has(actionRaw.trim().toLowerCase())) {
    return { ok: false, error: "on_fail.action must be abort, continue, or retry" };
  }
  const action = actionRaw.trim().toLowerCase() as FailurePolicy["action"];
  const hasRetries = Object.prototype.hasOwnProperty.call(record, "retries");
  const retries = hasRetries ? record.retries : 0;
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > 10) {
    return { ok: false, error: "failure policy retries must be an integer between 0 and 10" };
  }
  if (action !== "retry" && hasRetries && retries !== 0) {
    return { ok: false, error: "on_fail.retries is only valid for action=retry" };
  }
  const hasAllow = Object.prototype.hasOwnProperty.call(record, "allow_routing_change");
  const allow = hasAllow ? record.allow_routing_change : false;
  if (typeof allow !== "boolean") {
    return { ok: false, error: "on_fail.allow_routing_change must be boolean" };
  }
  return { ok: true, policy: policy(action, retries, allow) };
}

/** A stored budget is untrusted. Garbage falls back to 2. abort is 0. continue is the default. */
export function budgetOrDefault(value: unknown): number {
  if (value == null) return 2;
  const parsed = normalizeFailurePolicy(value);
  if (!parsed.ok) return 2;
  if (parsed.policy.action === "abort") return 0;
  if (parsed.policy.action === "retry") return parsed.policy.retries;
  return 2;
}

export const DEFAULT_BUDGET = 2;
export const MAX_BUDGET = 10;
