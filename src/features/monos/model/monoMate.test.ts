// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import type { CrewRule } from "../../crew/model/rules";
import { crewBriefLines } from "../../crew/model/briefLine";
import { firstMateLaunch } from "../../firstmate/model/checkoutGuard";
import { contractForAgents } from "../../firstmate/model/contract";
import { createMono, findMono, saveMonoSessionId, updateMono } from "./mono";
import { monoTurnNote, routeForMono } from "./monoMate";
import type { MonoFiles } from "./monoFiles";

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
});

const files = (soul: string): MonoFiles => ({
  id: "design",
  dir: "/data/monos/design",
  soul,
  soulHash: "s",
  memory: "",
  memoryHash: "m",
  memoryPath: "/data/monos/design/MEMORY.md",
  topics: [],
});

it("a Mono's turn carries the first mate contract and its soul, once", () => {
  const note = monoTurnNote(
    { name: "Ada", mascot: "dino", color: "x", projects: [] },
    files("You care about screens.\r\n"),
    { soul: true, memory: false },
  );
  const contract = contractForAgents();
  expect(note).toContain("# The first mate contract");
  expect(note).toContain("You are a first mate.");
  expect(note).toContain("You care about screens.");
  expect(note.split("# The first mate contract")).toHaveLength(2);
  expect(note).toContain(contract);
  expect(monoTurnNote(
    { name: "Ada", mascot: "dino", color: "x", projects: [] },
    files(note),
    { soul: true, memory: false },
  ).split("# The first mate contract")).toHaveLength(2);
});

it("an empty soul still carries the contract", () => {
  const note = monoTurnNote(
    { name: "Ada", mascot: "dino", color: "x", projects: [] },
    files("  \r\n"),
    { soul: true, memory: false },
  );
  expect(note).toContain("# The first mate contract");
});

it("a design Mono's stored rule picks Codex when the project's rule picks Claude", () => {
  const mono = createMono(["/work/design"]);
  updateMono(mono.id, (current) => ({
    ...current,
    name: "Ada",
    crewRules: [
      { labels: ["screen"], paths: [], cli: "codex", source: "person" },
      { labels: [], paths: ["../secret"], cli: "cursor", source: "person" },
      { labels: ["screen"], paths: [], cli: "not-a-cli", source: "person" },
    ],
  }));
  const stored = findMono(mono.id);
  const project: CrewRule = { labels: ["screen"], paths: [], cli: "claude", source: "person" };
  const present = [
    { cli: "claude", installed: true, signedIn: true },
    { cli: "codex", installed: true, signedIn: true },
  ];
  expect(stored?.crewRules).toEqual([{ labels: ["screen"], paths: [], cli: "codex", source: "person" }]);
  expect(routeForMono({ labels: ["screen"], paths: [] }, stored?.crewRules ?? [], [project], [], present).cli).toBe("codex");
  expect(routeForMono({ labels: ["screen"], paths: [] }, [], [project], [], present).cli).toBe("claude");
});

it("keeps a Mono's worker default, and drops one that isn't usable", () => {
  const mono = createMono(["/work/design"]);
  updateMono(mono.id, (current) => ({
    ...current,
    workerDefault: { cli: "grok", model: "grok-4", effort: "low" },
  }));
  expect(findMono(mono.id)?.workerDefault).toEqual({ cli: "grok", model: "grok-4", effort: "low" });
  updateMono(mono.id, (current) => ({
    ...current,
    workerDefault: { cli: "nope", model: "bad\nid", effort: "  high  " },
  }));
  expect(findMono(mono.id)?.workerDefault).toEqual({ effort: "high" });
  updateMono(mono.id, (current) => {
    const next = { ...current };
    delete next.workerDefault;
    return next;
  });
  expect(findMono(mono.id)?.workerDefault).toBeUndefined();
  // A Mono default is not an old project row. No CLI stays no CLI, not Claude.
  updateMono(mono.id, (current) => ({
    ...current,
    workerDefault: { model: "cursor:composer", effort: "huge" },
  }));
  expect(findMono(mono.id)?.workerDefault).toEqual({ model: "cursor:composer", effort: "huge" });
});

it("a design Mono's crew rule beats the coding team's and a plugin's", () => {
  const design: CrewRule = { labels: ["screen"], paths: [], cli: "codex", source: "person" };
  const project: CrewRule = { labels: ["screen"], paths: [], cli: "claude", source: "person" };
  const plugin: CrewRule = { labels: ["screen"], paths: [], cli: "cursor", source: "plugin" };
  const present = [
    { cli: "claude", installed: true, signedIn: true },
    { cli: "codex", installed: true, signedIn: true },
    { cli: "cursor", installed: true, signedIn: true },
  ];
  expect(routeForMono({ labels: ["screen"], paths: [] }, [design], [project], [plugin], present).cli).toBe("codex");
  expect(routeForMono({ labels: ["screen"], paths: [] }, [], [project], [plugin], present).cli).toBe("claude");
  expect(routeForMono({ labels: ["screen"], paths: [] }, [], [], [plugin], present).cli).toBe("cursor");
  expect(routeForMono({ labels: [], paths: [] }, [design], [project], [], present).cli).toBe("claude");
});

it("a Mono's own chat is a first mate even before the flag is stored", () => {
  const mono = createMono(["/work/My Project"]);
  saveMonoSessionId(mono.id, "chat-1");
  expect(firstMateLaunch({ id: "chat-1" })).toEqual({ firstMate: true });
  expect(firstMateLaunch({ id: "someone-else" })).toEqual({});
  expect(firstMateLaunch({ firstMate: true })).toEqual({ firstMate: true });
});

it("a Mono sees one line for a brief to a coding team, not the workers", () => {
  const rows = [
    { id: "brief", ownerSession: "mono-chat", follow: "lead", title: "Fix the save bug", createdAt: 2, status: "working" },
    { id: "brief", ownerSession: "mono-chat", follow: "lead", title: "Fix the save bug", createdAt: 2, status: "working" },
    { id: "w1", ownerSession: "coding-team", parentId: "brief", title: "worker detail that stays in the crew tab", status: "working" },
    { id: "w2", ownerSession: "coding-team", parentId: "brief", title: "another worker", status: "needs-you" },
    { id: "deep", ownerSession: "worker", parentId: "w1", follow: "lead", title: "a third level" },
    { id: "queued", ownerSession: "mono-chat", follow: "queue", title: "not a lead brief", createdAt: 1 },
    { id: "other", ownerSession: "someone", follow: "lead", title: "Not mine", createdAt: 0 },
  ];
  const lines = crewBriefLines("mono-chat", rows);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.text.startsWith("Fix the save bug")).toBe(true);
  expect(lines[0]?.text).not.toContain("worker detail");
  expect(lines[0]?.text).not.toContain("third level");
  expect(crewBriefLines("mono-chat", [])).toEqual([]);
});

it("WP-156: a Mono's fresh turn carries the project's standing answers only when the app handed a block", () => {
  const look = { name: "Ada", mascot: "dino", color: "x", projects: [] };
  const block = "Standing answers\nThese are guidance, not permission.\nS-7: Staging or prod first? -> Staging first";
  const plan = { soul: true, memory: false };
  const off = monoTurnNote(look, files("You care about screens."), plan);
  expect(off).not.toContain("<standing_answers>");
  expect(monoTurnNote(look, files("You care about screens."), plan, { standingAnswers: "" })).toBe(off);
  const on = monoTurnNote(look, files("You care about screens."), plan, { standingAnswers: block });
  expect(on).toContain(`<standing_answers>\n${block}\n</standing_answers>`);
  expect(on.indexOf("<standing_answers>")).toBeGreaterThan(on.indexOf("You care about screens."));
  // A turn that hands over memory only (no soul) does not repeat the project's answers.
  const memoryOnly = monoTurnNote(look, files("You care about screens."), { soul: false, memory: true }, { standingAnswers: block });
  expect(memoryOnly).not.toContain("<standing_answers>");
});
