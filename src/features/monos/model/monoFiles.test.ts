// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { createMono, findMono, HANDED_KEY, updateMono } from "./mono";
import {
  defaultSoul,
  DELEGATE_NOTE,
  HUB_NOTE,
  setHubDocsPath,
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

it("tells the Mono it runs in MonoCode Hub, who it is, its soul and memory, and how to reach Ash", () => {
  const look = {
    name: "Skull",
    mascot: "skull",
    color: "#fff",
    projects: [
      { path: "/code/monocode", name: "monocode" },
      { path: "/code/site", name: "site" },
    ],
  };
  const full = monoContext(look, files(), { soul: true, memory: true }, { cli: "/Apps/monocode app" });
  expect(full.startsWith(HUB_NOTE)).toBe(true);
  expect(full).toContain("running inside MonoCode Hub");
  expect(full).toContain("Deletes and money need Ash to click yes himself.");
  expect(full).toContain("To reach him, just reply here");
  expect(full).toContain("You are Skull.");
  expect(full).toContain("site (/code/site)");
  expect(full).toContain("<soul>\n# Soul\n\nBe brief.\n</soul>");
  expect(full).toContain("`/Apps/monocode app --help`");
  expect(full).toContain("Topic notes, read on demand with memory.read: releases");
  expect(full).toContain("releases are tag-triggered");
  expect(full).not.toMatch(/\u2014/);
  const memoryOnly = monoContext(look, files(), { soul: false, memory: true });
  expect(memoryOnly).not.toContain("<soul>");
  expect(memoryOnly).toContain("<memory>");
  expect(monoContext({ ...look, projects: [] }, files(), { soul: true, memory: false })).toContain("Ash hasn't given you a project yet.");
});

// Ash, 21 Oct: vanilla Claude Code plus a short note. Beyond the soul and memory, under 1 KB, and none of the old rules.
it("keeps the hub's note under 1 KB, with nothing about formats, recording, digests or review rounds", () => {
  const look = { name: "Chief of Staff", mascot: "skull", color: "#fff", projects: [{ path: "/code/hub", name: "hub" }] };
  const empty = { ...files(), soul: "", memory: "", topics: [] };
  const note = monoContext(look, empty, { soul: true, memory: true }, { delegate: true, teams: true, leads: ['Hub lead (lead "hub")'], cli: "/Applications/MonoCode.app/Contents/MacOS/monocode app" });
  expect(new TextEncoder().encode(note.replace("<soul>\n\n</soul>", "").replace(/<memory>[\s\S]*<\/memory>/, "")).length).toBeLessThan(1_000);
  for (const gone of ["<delegate_rules>", "<chat_rules>", "<ask_ash_rules>", "<autopilot_rules>", "Needs Ash:", "My pick:", "ash_record", "ash_remember", "digest", "review round", "numbered", "em dash", "Right:"])
    expect(note, gone).not.toContain(gone);
});

it("points every chat at the hub's docs once their path is known", () => {
  const look = { name: "Alfred", mascot: "skull", color: "#fff", projects: [] };
  expect(monoContext(look, files(), { soul: true, memory: false })).not.toContain("hub docs");
  setHubDocsPath("/Applications/MonoCode.app/Contents/Resources/hub-docs/README.md");
  try {
    expect(monoContext(look, files(), { soul: true, memory: false })).toContain(
      "- If you need to know how a hub feature works, read the hub docs at /Applications/MonoCode.app/Contents/Resources/hub-docs/README.md before guessing.",
    );
  } finally {
    setHubDocsPath(undefined);
  }
});

it("names the delegate tools only to a chat that has them, and a non-Lead's Leads", () => {
  const look = { name: "Alfred", mascot: "skull", color: "#fff", projects: [{ path: "/code/vg-game", name: "vg-game" }] };
  expect(monoContext(look, files(), { soul: true, memory: true })).not.toContain(DELEGATE_NOTE);
  const taught = monoContext(look, files(), { soul: true, memory: true }, { delegate: true, teams: true, leads: ['EXO lead (lead "vg-game")'] });
  expect(taught).toContain(DELEGATE_NOTE);
  expect(DELEGATE_NOTE).toContain("their descriptions explain them");
  expect(taught).toContain('delegate_task with "lead": EXO lead (lead "vg-game")');
  expect(monoContext(look, files(), { soul: false, memory: true }, { delegate: true })).not.toContain(DELEGATE_NOTE);
});

it("starts a Lead's fresh conversation on its project's memory, handed with the soul and never again mid-session", () => {
  const look = { name: "Hivra lead", mascot: "skull", color: "#fff", projects: [{ path: "/code/hivra", name: "hivra" }] };
  const projectMemory = "<project_memory>\n- Never delete a customer VM as a fix\n</project_memory>";
  const fresh = monoContext(look, files(), { soul: true, memory: true }, { delegate: true, projectMemory });
  expect(fresh).toContain(projectMemory);
  // after its soul, before its own MEMORY.md block
  expect(fresh.indexOf(projectMemory)).toBeGreaterThan(fresh.indexOf("</soul>"));
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
