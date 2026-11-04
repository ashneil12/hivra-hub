import { describe, expect, it } from "vitest";
import { draftRule, firstMatch, mergeRules, moveRule, pathMatches, ruleMatches, sanitizeRule, type CrewRule } from "./rules";

function rule(partial: Partial<CrewRule> & Pick<CrewRule, "labels" | "paths">): CrewRule {
  return { source: "person", ...partial };
}

describe("path matching", () => {
  it("matches a path and a file inside it, with either slash", () => {
    expect(pathMatches("src/app/main.tsx", "src/app")).toBe(true);
    expect(pathMatches("src\\app\\main.tsx", "src/app")).toBe(true);
    expect(pathMatches("src/app", "src/app")).toBe(true);
    expect(pathMatches("src/application", "src/app")).toBe(false);
    expect(pathMatches("src/other", "src/app")).toBe(false);
  });

  it("keeps spaces and unicode, and refuses ..", () => {
    expect(pathMatches("docs/my notes/á.txt", "docs/my notes")).toBe(true);
    expect(pathMatches("src/app", "../src")).toBe(false);
    expect(pathMatches("../secret", "src")).toBe(false);
    expect(pathMatches("src/app\r\n", "src/app")).toBe(true);
  });

  it("matches nothing for an empty path", () => {
    expect(pathMatches("", "src")).toBe(false);
    expect(pathMatches("src", "")).toBe(false);
    expect(pathMatches(".", "src")).toBe(false);
  });
});

describe("rule matching", () => {
  it("needs every dimension the rule sets, and ignores case on labels only", () => {
    const both = rule({ labels: ["ui"], paths: ["src/app"] });
    expect(ruleMatches(both, ["UI"], ["src/app/main.tsx"])).toBe(true);
    expect(ruleMatches(both, ["ui"], ["src/other"])).toBe(false);
    expect(ruleMatches(both, ["backend"], ["src/app"])).toBe(false);
    expect(ruleMatches(rule({ labels: ["docs"], paths: [] }), ["docs", "docs"], [])).toBe(true);
    expect(ruleMatches(both, ["ui"], [])).toBe(false);
  });

  it("matches nothing when the task has no labels and no paths", () => {
    expect(ruleMatches(rule({ labels: ["ui"], paths: [] }), [], [])).toBe(false);
    expect(ruleMatches(rule({ labels: ["ui"], paths: [] }), ["  "], [""])).toBe(false);
  });

  it("drops a broken stored rule and keeps a valid one", () => {
    expect(sanitizeRule({ labels: [], paths: [] }, "plugin")).toBeNull();
    expect(sanitizeRule({ labels: ["ui"], paths: ["../etc"], cli: "nope" }, "plugin")).toBeNull();
    expect(sanitizeRule({ labels: [" UI "], paths: ["src/app"], cli: "cursor", effort: "high" }, "person")).toEqual({
      labels: ["ui"],
      paths: ["src/app"],
      cli: "cursor",
      effort: "high",
      source: "person",
    });
    expect(sanitizeRule("nope", "plugin")).toBeNull();
  });

  it("the editor refuses a rule that matches nothing or picks nothing", () => {
    expect(draftRule({ labels: "", paths: "", cli: "cursor", model: "", effort: "" })).toBe("Give a label or a path.");
    expect(draftRule({ labels: "ui", paths: "", cli: "", model: "", effort: "" })).toBe("Pick a CLI, a model or an effort.");
    expect(draftRule({ labels: "ui", paths: "", cli: "nope", model: "", effort: "" })).toBe(
      "That isn't an agent CLI Hivra drives.",
    );
    expect(draftRule({ labels: "ui", paths: "src/app\r\n", cli: "cursor", model: "a\nb", effort: "low" })).toBe(
      "The model has to be one line.",
    );
    expect(draftRule({ labels: "UI, backend", paths: "", cli: "cursor", model: "", effort: "low" })).toMatchObject({
      labels: ["ui", "backend"],
      cli: "cursor",
      effort: "low",
    });
  });
});

describe("merge order", () => {
  const mono = [rule({ labels: ["ui"], paths: [], cli: "cursor" })];
  const project = [rule({ labels: ["ui"], paths: [], cli: "codex" })];
  const plugins = [rule({ labels: ["ui"], paths: [], cli: "pi", source: "plugin" })];

  it("puts the person's rules above a plugin, and the first match wins", () => {
    const merged = mergeRules(mono, project, plugins);
    expect(merged.map((row) => row.cli)).toEqual(["cursor", "codex", "pi"]);
    expect(merged[2].source).toBe("plugin");
    expect(firstMatch(merged, ["ui"], [])).toBe(0);
    expect(firstMatch(merged, ["docs"], [])).toBeNull();
  });

  it("moves and leaves an out of range move alone", () => {
    expect(moveRule(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveRule(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveRule(["a"], 5, 1)).toEqual(["a"]);
  });
});
