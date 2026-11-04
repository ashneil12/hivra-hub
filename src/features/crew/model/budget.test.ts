import { describe, expect, it } from "vitest";
import { budgetOrDefault, normalizeFailurePolicy } from "./budget";

describe("retry budget", () => {
  it("accepts retry(n), abort, continue and a real integer", () => {
    expect(normalizeFailurePolicy("retry(2)")).toEqual({
      ok: true,
      policy: { action: "retry", retries: 2, allowRoutingChange: false },
    });
    expect(normalizeFailurePolicy("retry(0)")).toMatchObject({ ok: true, policy: { retries: 0 } });
    expect(normalizeFailurePolicy("abort")).toMatchObject({ ok: true, policy: { action: "abort", retries: 0 } });
    expect(normalizeFailurePolicy(10)).toMatchObject({ ok: true, policy: { action: "retry", retries: 10 } });
    expect(normalizeFailurePolicy({ action: "retry", retries: 1, allow_routing_change: true })).toMatchObject({
      ok: true,
      policy: { retries: 1, allowRoutingChange: true },
    });
  });

  it("rejects a boolean, a count past 10, and retries on abort", () => {
    expect(normalizeFailurePolicy(true).ok).toBe(false);
    expect(normalizeFailurePolicy(false).ok).toBe(false);
    expect(normalizeFailurePolicy("retry(11)").ok).toBe(false);
    expect(normalizeFailurePolicy(11).ok).toBe(false);
    expect(normalizeFailurePolicy(-1).ok).toBe(false);
    expect(normalizeFailurePolicy(2.5).ok).toBe(false);
    expect(normalizeFailurePolicy({ action: "abort", retries: 3 }).ok).toBe(false);
    expect(normalizeFailurePolicy({ action: "retry", retries: true }).ok).toBe(false);
    expect(normalizeFailurePolicy({ action: "retry", extra: 1 }).ok).toBe(false);
    expect(normalizeFailurePolicy({ action: "retry", allow_routing_change: "yes" }).ok).toBe(false);
    expect(normalizeFailurePolicy("nope").ok).toBe(false);
  });

  it("falls back to 2 for a missing or garbage stored budget", () => {
    expect(budgetOrDefault(undefined)).toBe(2);
    expect(budgetOrDefault(null)).toBe(2);
    expect(budgetOrDefault(true)).toBe(2);
    expect(budgetOrDefault("retry(11)")).toBe(2);
    expect(budgetOrDefault("nope")).toBe(2);
    expect(budgetOrDefault("abort")).toBe(0);
    expect(budgetOrDefault("retry(0)")).toBe(0);
    expect(budgetOrDefault("continue")).toBe(2);
    expect(budgetOrDefault(1)).toBe(1);
  });
});
