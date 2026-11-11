// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { CAPTAIN_CHARTER } from "../../chief/model/charter";
import { createMono, findMono, HANDED_KEY, updateMono } from "./mono";
import {
  defaultSoul,
  HUB_NOTE_TEMPLATE,
  hubNote,
  setHubDocsPath,
  loadMonoFiles,
  MEMORY_MAX_LINES,
  memoryWithinBudget,
  planAgentContext,
  monoContext,
  monoTurn,
  recordAgentContext,
  resetMonoDefaults,
  writeAgentFile,
} from "./monoFiles";

beforeEach(() => {
  const stored = new Map<string, string>([["monocode:hub-team-pack", "ash"]]); // Ash's install: the app's words name him (userName.ts)
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
  expect(full.startsWith(`${hubNote()}\n\n- You are Skull.`)).toBe(true);
  expect(full).toContain("running inside MonoCode Hub");
  expect(full).toContain("- Deletes need Ash's own yes.");
  expect(full).not.toMatch(/money/i);
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

// Ash, 21 Oct: vanilla Claude Code plus a short note. Beyond the soul and memory, about 1 KB (1.1 KB since Alfred's
// memory-save line, 21 Oct; the note itself is ~860 bytes), and none of the old rules.
it("keeps the hub's note about 1 KB, with nothing about formats, recording, digests or review rounds", () => {
  const look = { name: "Chief of Staff", mascot: "skull", color: "#fff", projects: [{ path: "/code/hub", name: "hub" }] };
  const empty = { ...files(), soul: "", memory: "", topics: [] };
  const note = monoContext(look, empty, { soul: true, memory: true }, { delegate: true, teams: true, leads: ['"hub"'], cli: "/Applications/MonoCode.app/Contents/MacOS/monocode app" });
  expect(new TextEncoder().encode(note.replace("<soul>\n\n</soul>", "").replace(/<memory>[\s\S]*<\/memory>/, "")).length).toBeLessThan(1_100);
  for (const gone of ["<delegate_rules>", "<chat_rules>", "<ask_ash_rules>", "<autopilot_rules>", "Needs Ash:", "My pick:", "ash_record", "ash_remember", "digest", "review round", "numbered", "em dash", "Right:"])
    expect(note, gone).not.toContain(gone);
});

// Alfred's hub-note.md (hub-scenarios/slim-souls, 21 Oct), word for word, with the bundled docs path filled in.
const ALFRED_NOTE = `You're running inside MonoCode Hub, Ash's app for running a small team of agents (Monos). Otherwise you're your normal self.

- Your soul file says who you are and what you own. Your memory files are yours.
- Ash talks to you in chats and rooms. Other Monos are in the rooms too.
- Hub tools: hand work to another Mono, post in a room, make a new Mono with Ash in chat, make a page, and propose a change to the hub. Pages and hub changes show Ash a preview first; he clicks Apply or Discard. Anything applied can be undone in Bot changes.
- When you save a memory, keep Ash's own words, credited to him. A question he asked stays a question, and nothing gets saved as further along than it was. Unapproved cards aren't decisions.
- Deletes need Ash's own yes.
- Name work by what it is, not task ids or paths.
- For how a hub feature works, read the hub docs at HUB_DOCS_PATH before guessing.`;

it("is Alfred's shared note word for word, the docs path filled in once known and its line left out before", () => {
  expect(HUB_NOTE_TEMPLATE).toBe(ALFRED_NOTE);
  expect(hubNote()).toBe(ALFRED_NOTE.split("\n").slice(0, -1).join("\n"));
  const look = { name: "Alfred", mascot: "skull", color: "#fff", projects: [] };
  expect(monoContext(look, files(), { soul: true, memory: false })).not.toContain("hub docs");
  setHubDocsPath("/Applications/MonoCode.app/Contents/Resources/hub-docs/README.md");
  try {
    expect(hubNote()).toBe(ALFRED_NOTE.replace("HUB_DOCS_PATH", "/Applications/MonoCode.app/Contents/Resources/hub-docs/README.md"));
    expect(monoContext(look, files(), { soul: true, memory: false }).startsWith(hubNote())).toBe(true);
  } finally {
    setHubDocsPath(undefined);
  }
});

it("names a non-Lead's Leads only to a chat that has the delegate tool", () => {
  const look = { name: "Alfred", mascot: "skull", color: "#fff", projects: [{ path: "/code/vg-game", name: "vg-game" }] };
  const taught = monoContext(look, files(), { soul: true, memory: true }, { delegate: true, teams: true, leads: ['"vg-game"'] });
  expect(taught).toContain('- A project\'s work goes to its Lead (delegate_task "lead": "vg-game")');
  expect(monoContext(look, files(), { soul: true, memory: true }, { leads: ['"vg-game"'] })).not.toContain("delegate_task");
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

it("gives an existing coordinator the charter on load, and leaves anyone else alone", async () => {
  const { id } = createMono(["/code/app"]);
  updateMono(id, (mono) => ({ ...mono, name: "Chief of Staff" }));
  const soul = "# Soul\n\n## Role\nI am the coordinator.\n";
  invoke.mockImplementation(async (command: string) =>
    command === "mono_load" ? { ...files("old"), soul, topics: [] } : "with-charter",
  );
  const loaded = await loadMonoFiles(id);
  expect(loaded.soul).toContain(CAPTAIN_CHARTER);
  expect(loaded.soul).toContain("I am the coordinator.");
  const saves = invoke.mock.calls.filter(([command]) => command === "mono_save");
  expect(saves).toHaveLength(1);
  expect(String(saves[0]?.[1] && (saves[0][1] as { text?: string }).text)).toContain(`\n## Role\n${CAPTAIN_CHARTER}\n`);

  invoke.mockClear();
  const { id: missedId } = createMono(["/code/app"]);
  updateMono(missedId, (mono) => ({ ...mono, name: "Coordinator" }));
  invoke.mockImplementation(async (command: string) => {
    if (command === "mono_load") return { ...files("old"), soul, topics: [] };
    throw new Error("down");
  });
  const missed = await loadMonoFiles(missedId);
  expect(missed.soul).toBe(soul);
  expect(missed.soul).not.toContain(CAPTAIN_CHARTER);

  invoke.mockClear();
  const { id: plain } = createMono();
  invoke.mockImplementation(async (command: string) =>
    command === "mono_load" ? { ...files("plain"), soul: "# Soul\n\nBe brief.", topics: [] } : "nope",
  );
  const left = await loadMonoFiles(plain);
  expect(left.soul).toBe("# Soul\n\nBe brief.");
  expect(invoke.mock.calls.filter(([command]) => command === "mono_save")).toHaveLength(0);
});

it("flags a mono the captain on load when its soul already has the charter, whatever it is called", async () => {
  const { id } = createMono(["/code/app"]);
  updateMono(id, (mono) => ({ ...mono, name: "Planner" }));
  const soul = `# Soul\n\n## Role\n${CAPTAIN_CHARTER}\n`;
  invoke.mockImplementation(async (command: string) =>
    command === "mono_load" ? { ...files("old"), soul, topics: [] } : "same",
  );
  const loaded = await loadMonoFiles(id);
  expect(loaded.soul).toBe(soul);
  expect(findMono(id)?.captain).toBe(true);
  expect(invoke.mock.calls.filter(([command]) => command === "mono_save")).toHaveLength(0);
});

it("flags a stored mono whose instructions already carry the charter", () => {
  const { id } = createMono(["/code/app"]);
  updateMono(id, (mono) => {
    const { captain: _captain, ...rest } = mono;
    return { ...rest, name: "Planner", instructions: `# Soul\n${CAPTAIN_CHARTER}\n` };
  });
  expect(findMono(id)?.captain).toBe(true);
  const stored = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { id: string; captain?: boolean }[];
  expect(stored.find((row) => row.id === id)?.captain).toBe(true);
});

it("refuses a soul save that drops the charter, and keeps it when that Mono is reset", async () => {
  const { id } = createMono();
  const soul = `# Soul\n\n${CAPTAIN_CHARTER}\n`;
  invoke.mockImplementation(async (command: string) => {
    if (command === "mono_read") return { text: soul, hash: "h1" };
    if (command === "mono_load") return { ...files("h1"), soul, topics: [] };
    return "saved";
  });
  await expect(writeAgentFile(id, "SOUL.md", "# Soul\n\nGone.\n", "h1")).rejects.toThrow(/charter is fixed/);
  expect(invoke.mock.calls.some(([command]) => command === "mono_save")).toBe(false);

  updateMono(id, (mono) => ({ ...mono, name: "Chief of Staff" }));
  await resetMonoDefaults(id);
  const saves = invoke.mock.calls.filter(([command]) => command === "mono_save");
  expect(saves).toHaveLength(1);
  expect(String((saves[0]?.[1] as { text?: string }).text)).toContain(CAPTAIN_CHARTER);
});

it("does not save a soul when the current one could not be read", async () => {
  const { id } = createMono();
  invoke.mockImplementation(async (command: string) => {
    if (command === "mono_read") throw new Error("disk");
    return "saved";
  });
  await expect(writeAgentFile(id, "SOUL.md", "# Soul\n\nKept.\n", "h1")).rejects.toThrow(/could not be read/);
  expect(invoke.mock.calls.some(([command]) => command === "mono_save")).toBe(false);

  invoke.mockImplementation(async (command: string) => {
    if (command === "mono_read") return { text: null, hash: "h0" };
    return "saved-new";
  });
  await expect(writeAgentFile(id, "SOUL.md", "# Soul\n\nFirst.\n")).resolves.toBe("saved-new");
  expect(invoke.mock.calls.some(([command]) => command === "mono_save")).toBe(true);
});

it("a whole soul given as instructions (the hub's team) is kept as it is; anything else goes under Standing instructions", () => {
  const soul = "# Soul\n\n## Role\nI run the plan.\n";
  expect(defaultSoul(soul)).toBe(soul);
  expect(defaultSoul(`  ${soul}  `)).toBe(soul);
  expect(defaultSoul("Ship on Fridays")).toBe("# Soul\n\n## Standing instructions\nShip on Fridays\n");
  expect(defaultSoul("# Soulful notes")).toContain("## Standing instructions\n# Soulful notes");
});
