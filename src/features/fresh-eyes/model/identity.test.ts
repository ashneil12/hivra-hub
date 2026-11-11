import { describe, expect, it } from "vitest";
import { briefHash, canonicalJson, decisionKeyFor, startKeyFor } from "./identity";

describe("which brief a review is about", () => {
  it("is the same for the same call however its keys are ordered, and different for anything else", () => {
    const a = { brief: "Fix it", title: "Fix", reading: [{ path: "a.ts", text: "x" }] };
    const b = { reading: [{ text: "x", path: "a.ts" }], title: "Fix", brief: "Fix it" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(briefHash("lead", a)).toBe(briefHash("lead", b));
    expect(briefHash("lead", a)).toMatch(/^[0-9a-f]{64}$/);
    expect(briefHash("lead", a)).not.toBe(briefHash("lead", { ...a, brief: "Fix it now" }));
    expect(briefHash("lead", a)).not.toBe(briefHash("other", a));
    expect(briefHash("lead", a)).not.toBe(briefHash("lead", { ...a, extra: true }));
    expect(briefHash("lead", a)).toBe(briefHash(" lead ", a));
  });

  it("names the question by request, chat and brief, and keeps it a key the Inbox accepts", () => {
    const hash = briefHash("lead", { brief: "Fix it" });
    const key = decisionKeyFor("r1", "lead", hash);
    expect(key).toMatch(/^fresh-eyes\/r1\/[0-9a-f]{16}$/);
    expect(decisionKeyFor("r1", "lead", briefHash("lead", { brief: "Fix it too" }))).not.toBe(key);
    expect(decisionKeyFor("r1", "other", hash)).not.toBe(key);
    // The Inbox keeps a key to 120 characters, of letters, digits and - _ . : /.
    const long = "r".repeat(100);
    for (const made of [decisionKeyFor(long, "lead", hash), startKeyFor(long, "lead", hash, 1)]) {
      expect(made.length).toBeLessThanOrEqual(120);
      expect(made).toMatch(/^[A-Za-z0-9\-_.:/]+$/);
    }
    // Two long request IDs that share a start do not share a question.
    expect(decisionKeyFor(`${"r".repeat(70)}a`, "lead", hash)).not.toBe(decisionKeyFor(`${"r".repeat(70)}b`, "lead", hash));
    expect(startKeyFor("r1", "lead", hash, 1)).not.toBe(key);
    // Each give-up is its own question, so an answered one is never taken for the answer to the next.
    expect(startKeyFor("r1", "lead", hash, 1)).not.toBe(startKeyFor("r1", "lead", hash, 2));
    expect(startKeyFor("r1", "lead", hash, 2)).toBe(startKeyFor("r1", "lead", hash, 2));
  });
});
