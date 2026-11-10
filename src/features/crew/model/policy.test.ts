import { describe, expect, it } from "vitest";
import {
  casPolicy,
  isRoleSlotRule,
  loadBook,
  placeRoleSlots,
  policyInForce,
  roleSlotRule,
  sanitizePolicy,
  saveBook,
  upsertRoleSlot,
  weaveRoleSlots,
  writePolicy,
  type CrewPolicy,
} from "./policy";
import type { CrewRule } from "./rules";

const plugin: CrewRule = { labels: ["builder"], paths: [], cli: "pi", source: "plugin" };

describe("sanitizePolicy", () => {
  it("drops a broken book and keeps only a real lock", () => {
    expect(sanitizePolicy(null)).toEqual({ lockDefault: false, neverUse: [], fallback: [] });
    expect(sanitizePolicy({ lockDefault: "yes", neverUse: "codex" })).toEqual({
      lockDefault: false,
      neverUse: [],
      fallback: [],
    });
    expect(sanitizePolicy({ lockDefault: true }).lockDefault).toBe(true);
  });

  it("drops paths, duplicates, blanks and unknown CLIs, and keeps the person's order", () => {
    const policy = sanitizePolicy({
      lockDefault: false,
      neverUse: ["codex", "codex", "../ada", "ada", "C:\\mono", "nope\ncli", "  grok  ", "a".repeat(80)],
      fallback: ["grok", "not-a-cli", "claude", "grok", "codex"],
    });
    expect(policy.neverUse).toEqual(["codex", "ada", "grok"]);
    expect(policy.fallback).toEqual(["grok", "claude", "codex"]);
  });
});

describe("load and save", () => {
  it("round-trips a system, a project and a Mono, and drops a bad key", () => {
    const saved = saveBook(
      writePolicy(writePolicy(writePolicy({ projects: {}, monos: {} }, {}, { lockDefault: true, neverUse: [], fallback: ["codex"] }), { project: "My Documents/ünicode" }, { lockDefault: false, neverUse: ["pi"], fallback: [] }), {
        mono: "ada",
      }, { lockDefault: false, neverUse: ["ada"], fallback: ["grok"] }),
    );
    expect(policyInForce(saved, {})).toEqual({ lockDefault: true, neverUse: [], fallback: ["codex"] });
    expect(policyInForce(saved, { project: "My Documents/ünicode" }).neverUse).toEqual(["pi"]);
    expect(policyInForce(saved, { mono: "ada" }).fallback).toEqual(["grok"]);
    expect(policyInForce(saved, { project: "other" }).lockDefault).toBe(true);
    expect(loadBook({ projects: { "../x": { lockDefault: true } }, monos: { "../m": { lockDefault: true } } })).toEqual({
      projects: {},
      monos: {},
    });
  });

  it("a Mono with no row uses the project, then the system, and a stale save does not write", () => {
    const book = writePolicy({ system: { lockDefault: true, neverUse: ["codex"], fallback: [] }, projects: {}, monos: {} }, { project: "app" }, {
      lockDefault: false,
      neverUse: [],
      fallback: ["grok"],
    });
    expect(policyInForce(book, { mono: "ada" })).toEqual({ lockDefault: true, neverUse: ["codex"], fallback: [] });
    expect(policyInForce(book, { mono: "ada", project: "app" }).fallback).toEqual(["grok"]);
    expect(policyInForce(book, { project: "app" }).fallback).toEqual(["grok"]);
    const stale = casPolicy(1, 2, { lockDefault: true, neverUse: [], fallback: [] });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toContain("Reload");
    const fresh = casPolicy(2, 2, { lockDefault: true, neverUse: ["not a cli"], fallback: ["cursor"] });
    expect(fresh).toEqual({
      ok: true,
      revision: 3,
      policy: { lockDefault: true, neverUse: [], fallback: ["cursor"] } satisfies CrewPolicy,
    });
  });
});

describe("role slots", () => {
  it("stores a role as one person rule and leaves other rules where they are", () => {
    const path: CrewRule = { labels: ["ui"], paths: ["src/app"], cli: "cursor", source: "person" };
    const next = upsertRoleSlot([path, plugin], "builder", { cli: "codex", model: "gpt-5", effort: "high" });
    expect(next[0]).toEqual(path);
    expect(next[1]).toEqual(plugin);
    expect(next[2]).toMatchObject({ labels: ["builder"], paths: [], cli: "codex", source: "person" });
    expect(isRoleSlotRule(next[2])).toBe(true);
    expect(isRoleSlotRule(plugin)).toBe(false);
    expect(isRoleSlotRule(path)).toBe(false);
    const cleared = upsertRoleSlot(next, "builder", {});
    expect(cleared).toEqual([path, plugin]);
  });

  it("replaces the same role in place and refuses a model that is not one line", () => {
    const first = roleSlotRule("reviewer", { cli: "grok" });
    expect(first?.labels).toEqual(["reviewer"]);
    const replaced = upsertRoleSlot([first!], "reviewer", { cli: "codex" });
    expect(replaced).toHaveLength(1);
    expect(replaced[0].cli).toBe("codex");
    expect(roleSlotRule("researcher", { model: "a\nb" })).toBeNull();
    expect(roleSlotRule("nope", { cli: "codex" })).toBeNull();
  });

  it("keeps a role rule where it was, and keeps a second rule for that role", () => {
    const first: CrewRule = { labels: ["builder"], paths: [], cli: "grok", source: "person" };
    const path: CrewRule = { labels: ["ui"], paths: ["src"], cli: "cursor", source: "person" };
    const second: CrewRule = { labels: ["builder"], paths: [], cli: "codex", source: "person" };
    const placed = placeRoleSlots([first, path, second], { builder: { cli: "claude" } });
    expect(placed.map((rule) => rule.labels[0])).toEqual(["builder", "ui", "builder"]);
    expect(placed.map((rule) => rule.cli)).toEqual(["claude", "cursor", "codex"]);
    const woven = weaveRoleSlots([first, path, second], [path]);
    expect(woven.map((rule) => rule.cli)).toEqual(["grok", "cursor", "codex"]);
  });
});
