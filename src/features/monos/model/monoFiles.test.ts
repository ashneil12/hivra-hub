// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { createMono, findMono, HANDED_KEY, updateMono } from "./mono";
import {
  CHAT_RULES,
  defaultSoul,
  DELEGATE_NOTE,
  loadMonoFiles,
  MEMORY_MAX_LINES,
  memoryWithinBudget,
  planAgentContext,
  monoContext,
  monoTurn,
  recordAgentContext,
  resetMonoDefaults,
} from "./monoFiles";

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  invoke.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const files = (soulHash = "s1", memoryHash = "m1") => ({
  id: "agent",
  dir: "/data/agents/agent",
  soul: "# Soul\n\nBe brief.",
  soulHash,
  memory: "- 2026-10-04 · releases are tag-triggered",
  memoryHash,
  memoryPath: "/data/agents/agent/MEMORY.md",
  topics: ["releases"],
});

it("hands a new native session everything, then nothing it already has", () => {
  expect(planAgentContext("chat", undefined, files())).toEqual({
    soul: true,
    memory: true,
  });
  // The first turn is recorded before its reply names the provider session.
  recordAgentContext("chat", undefined, files());
  expect(planAgentContext("chat", "native-1", files())).toEqual({
    soul: false,
    memory: false,
  });
  recordAgentContext("chat", "native-1", files());
  expect(planAgentContext("chat", "native-1", files())).toEqual({
    soul: false,
    memory: false,
  });
});

it("resends memory when it changed, and everything for a new session", () => {
  recordAgentContext("chat", "native-1", files());
  expect(planAgentContext("chat", "native-1", files("s1", "m2"))).toEqual({
    soul: false,
    memory: true,
  });
  expect(planAgentContext("chat", "native-1", files("s2", "m1"))).toEqual({
    soul: true,
    memory: true,
  });
  // A model switch or a rotated session starts a different native session.
  expect(planAgentContext("chat", "native-2", files())).toEqual({
    soul: true,
    memory: true,
  });
});

it("refreshes standing rules in an existing conversation after a context upgrade", () => {
  localStorage.setItem(
    HANDED_KEY,
    JSON.stringify({
      chat: { provider: "native-1", soulHash: "s1:v6", memoryHash: "m1" },
    }),
  );
  expect(planAgentContext("chat", "native-1", files())).toEqual({
    soul: true,
    memory: true,
  });
  recordAgentContext("chat", "native-1", files());
  expect(planAgentContext("chat", "native-1", files())).toEqual({
    soul: false,
    memory: false,
  });
});

it("loads only whole lines within the memory budget", () => {
  const memory = Array.from(
    { length: MEMORY_MAX_LINES + 5 },
    (_, i) => `- fact ${i}`,
  ).join("\n");
  const budget = memoryWithinBudget(memory);
  expect(budget.lines).toBe(MEMORY_MAX_LINES + 5);
  expect(budget.droppedLines).toBe(5);
  expect(budget.text.split("\n")).toHaveLength(MEMORY_MAX_LINES);
  expect(memoryWithinBudget("").lines).toBe(0);
});

it("hands who the Mono is, its soul, its memory and a short note on its tools", () => {
  const look = {
    name: "Skull",
    mascot: "skull",
    color: "#fff",
    projects: [
      { path: "/code/monocode", name: "monocode" },
      { path: "/code/site", name: "site" },
    ],
  };
  const full = monoContext(look, files(), { soul: true, memory: true });
  expect(full).toContain("You are Skull, a Mono in MonoCode");
  expect(full).toContain("these 2 projects (monocode and site)");
  expect(full).toContain("- site: /code/site");
  expect(full).toContain("Be brief.");
  // The soul changes only when the user asks, through the app.
  expect(full).toContain("Change them only when the user asks: app soul.read, then app soul.update");
  for (const tool of ["memory.add", "habits", "artifacts.write", "sessions.start", "<reaction>👍</reaction>"]) expect(full).toContain(tool);
  expect(full).toContain("Topic notes, read on demand with memory.read: releases");
  expect(full).toContain("releases are tag-triggered");
  expect(full).not.toMatch(/\u2014/);
  const memoryOnly = monoContext(look, files(), { soul: false, memory: true });
  expect(memoryOnly).not.toContain("<soul>");
  expect(memoryOnly).toContain("<memory>");
  const alone = monoContext({ ...look, projects: [] }, files(), { soul: true, memory: false });
  expect(alone).toContain("has not given you any projects yet");
});

// Ash, 21 Oct: the hub is a thin layer over Claude Code. What it adds to a turn stays small: soul, memory, a tools note.
it("keeps the fixed rules a Mono is handed small", () => {
  const look = { name: "Chief of Staff", mascot: "skull", color: "#fff", projects: [{ path: "/code/hub", name: "hub" }] };
  const empty = { ...files(), soul: "", memory: "", topics: [] };
  const rules = monoContext(look, empty, { soul: true, memory: true }, { delegate: true, teams: true, leads: ['Hub lead (lead "hub")'] });
  expect(new TextEncoder().encode(rules).length).toBeLessThan(5_000);
  for (const gone of ["<delegate_rules>", "<talk_rules>", "<session_completion_rules>", "<pull_request_rules>", "ash_record", "List every ask back"])
    expect(rules).not.toContain(gone);
});

it("talks a dump through instead of sorting it, unless it is clearly a to-do list", () => {
  const look = { name: "EXO lead", mascot: "skull", color: "#fff", projects: [{ path: "/code/vg-game", name: "vg-game" }] };
  const context = monoContext(look, files(), { soul: true, memory: true });
  expect(context).toContain(CHAT_RULES);
  expect(CHAT_RULES).toContain("talk it through with him");
  expect(CHAT_RULES).toContain("Start work from a dump only when it is clearly a to-do list or he says go");
});

it("tells only a chat with the delegate tool about it, once, with the soul", () => {
  const look = { name: "EXO lead", mascot: "skull", color: "#fff", projects: [{ path: "/code/vg-game", name: "vg-game" }] };
  expect(monoContext(look, files(), { soul: true, memory: true })).not.toContain("<delegate_tools>");
  const taught = monoContext(look, files(), { soul: true, memory: true }, { delegate: true });
  expect(taught).toContain(DELEGATE_NOTE);
  for (const point of [
    "delegate_task",
    "pr_watch",
    "end your turn",
    "[MonoCode report]",
    "[MonoCode question]",
    // The hourly progress check stays (Ash, 14 Oct), as the Lead's own habit.
    "After about an hour, check a worker is really moving",
    "stop, split or retry it",
    // Ash OS saves only on remember or lock (21 Oct).
    "only when Ash says remember or lock",
    // The checker's private ping, answered in one line.
    "[MonoCode check]",
    '"Right:" or "Fixed:"',
  ])
    expect(DELEGATE_NOTE).toContain(point);
  expect(monoContext(look, files(), { soul: false, memory: true }, { delegate: true })).not.toContain("<delegate_tools>");
});

// Ash, 20 Oct: "monos shouldn't really have sub chats".
it("tells a Mono that isn't a Lead where its work goes: itself, a project's Lead, or its own team", () => {
  const look = { name: "Alfred", mascot: "skull", color: "#fff", projects: [{ path: "/code/vg-game", name: "vg-game" }] };
  const taught = monoContext(look, files(), { soul: true, memory: true }, { delegate: true, teams: true, leads: ['EXO lead (lead "vg-game")'] });
  expect(taught).toContain("<team_rules>");
  expect(taught).toContain('EXO lead (lead "vg-game")');
  expect(taught).toContain("Keep no sub-chats");
  expect(taught).toContain("delegate_task with no project");
  expect(monoContext(look, files(), { soul: true, memory: true }, { teams: true })).not.toContain("<team_rules>");
  expect(monoContext(look, files(), { soul: true, memory: true }, { delegate: true })).not.toContain("<team_rules>");
});

it("starts a Lead's fresh conversation on its project's memory, handed with the soul and never again mid-session", () => {
  const look = { name: "Hivra lead", mascot: "skull", color: "#fff", projects: [{ path: "/code/hivra", name: "hivra" }] };
  const projectMemory = "<project_memory>\n- Never delete a customer VM as a fix\n</project_memory>";
  const fresh = monoContext(look, files(), { soul: true, memory: true }, { delegate: true, projectMemory });
  expect(fresh).toContain(projectMemory);
  // before its own MEMORY.md block, after the rules
  expect(fresh.indexOf(projectMemory)).toBeGreaterThan(fresh.indexOf("<delegate_tools>"));
  expect(fresh.indexOf(projectMemory)).toBeLessThan(fresh.indexOf("<memory>"));
  // a turn that only hands a changed MEMORY.md, or a chat with no project, carries none
  expect(monoContext(look, files(), { soul: false, memory: true }, { projectMemory })).not.toContain("<project_memory>");
  expect(monoContext(look, files(), { soul: true, memory: true }, { projectMemory: " " })).not.toContain("<project_memory>");
});

it("seeds SOUL.md once, moving the old instructions into it", async () => {
  const { id } = createMono(["/code/app"]);
  updateMono(id, (mono) => ({ ...mono, instructions: "Ship on Fridays" }));
  invoke.mockImplementation(async (command: string) =>
    command === "mono_load" ? { ...files("empty"), soul: null } : "seeded",
  );
  const [first, second] = await Promise.all([
    loadMonoFiles(id),
    loadMonoFiles(id),
  ]);
  expect(first).toBe(second);
  expect(first.soul).toBe(defaultSoul("Ship on Fridays"));
  expect(first.soulHash).toBe("seeded");
  const saves = invoke.mock.calls.filter(
    ([command]) => command === "mono_save",
  );
  expect(saves).toHaveLength(1);
  expect(saves[0][1]).toMatchObject({
    mono: id,
    path: "SOUL.md",
    expectedHash: "empty",
  });
  expect(findMono(id)?.instructions).toBeUndefined();
});

it("resets a Mono to the default soul and name, over the soul it loaded", async () => {
  const { id } = createMono();
  updateMono(id, (mono) => ({ ...mono, name: "Broski" }));
  invoke.mockImplementation(async (command: string) =>
    command === "mono_load"
      ? { ...files("mine"), soul: "# Soul\n\nBe a pirate." }
      : "reset",
  );
  await resetMonoDefaults(id);
  const saves = invoke.mock.calls.filter(
    ([command]) => command === "mono_save",
  );
  expect(saves).toHaveLength(1);
  expect(saves[0][1]).toMatchObject({
    path: "SOUL.md",
    text: defaultSoul(),
    expectedHash: "mine",
  });
  expect(findMono(id)?.name).toBeUndefined();
});

it("reads a migrated Mono's old project folder once, then its own", async () => {
  const { id } = createMono(["/code/app"]);
  updateMono(id, (mono) => ({ ...mono, legacyProject: "/code/app" }));
  invoke.mockImplementation(async () => ({ ...files(), soul: "# Soul" }));
  await loadMonoFiles(id);
  expect(invoke.mock.calls[0]).toEqual([
    "mono_load",
    { mono: id, legacyProject: "/code/app" },
  ]);
  expect(findMono(id)?.legacyProject).toBeUndefined();
  await loadMonoFiles(id);
  expect(invoke.mock.calls[1]).toEqual([
    "mono_load",
    { mono: id, legacyProject: null },
  ]);
});

it("puts what the app adds ahead of the user's message, marked as its own", () => {
  expect(monoTurn("what is this", [])).toBe("what is this");
  const turn = monoTurn("what is this", ["<mono>\nYou are Cat.\n</mono>"]);
  expect(turn.startsWith("<monocode_context>")).toBe(true);
  expect(turn).toContain("they did not write it");
  expect(turn.indexOf("You are Cat.")).toBeLessThan(
    turn.indexOf("what is this"),
  );
  expect(turn.endsWith("</monocode_context>\n\nwhat is this")).toBe(true);
});

it("a whole soul given as instructions (the hub's team) is kept as it is; anything else goes under Standing instructions", () => {
  const soul = "# Soul\n\n## Role\nI run the plan.\n";
  expect(defaultSoul(soul)).toBe(soul);
  expect(defaultSoul(`  ${soul}  `)).toBe(soul);
  expect(defaultSoul("Ship on Fridays")).toBe("# Soul\n\n## Standing instructions\nShip on Fridays\n");
  expect(defaultSoul("# Soulful notes")).toContain("## Standing instructions\n# Soulful notes");
});
