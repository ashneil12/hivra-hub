// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newSession } from "../../sessions/model/session";
import { leafIds, newTab, splitPane } from "../../workspace/model/layout";
import { planWorkspaceTabClose } from "../../workspace/model/workspaceTabGroups";
import { addMono, createMono, engineFieldsOf, findMono, monoEngine, parseMonoEngine, saveMonoName, saveMonoSessionId } from "./mono";
import { planAgentContext, recordAgentContext } from "./monoFiles";
import { loadMonoRotation, saveMonoRotation } from "./monoRotation";
import { removeMono } from "./mono";
import {
  detachMonoTabs,
  ensureMonoRoomSession,
  ensureMonoSession,
  resetMonoSession,
} from "./monoWorkspace";

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

const chat = (id: string, cwd = "/project") => ({
  ...newSession("codex", cwd),
  id,
});
const createSession = (cwd: string) => newSession("codex", cwd);

/** A Mono that works on `cwd`, with `sessionId` as its chat. */
function monoFor(cwd: string, sessionId: string): string {
  const mono = createMono([cwd]);
  saveMonoSessionId(mono.id, sessionId);
  return mono.id;
}
const sessionOf = (monoId: string) => findMono(monoId)?.sessionId;

it("loads an existing resident conversation without creating a session", async () => {
  const agent = { ...chat("resident"), runtimeMode: "full-access" as const };
  const monoId = monoFor(agent.cwd, agent.id);
  const host = {
    home: vi.fn().mockResolvedValue("/home"),
    load: vi.fn().mockResolvedValue(agent),
    create: vi.fn(createSession),
    add: vi.fn(),
  };
  expect(await ensureMonoSession(monoId, host)).toBe(agent);
  expect(host.load).toHaveBeenCalledExactlyOnceWith(agent.id);
  expect(host.create).not.toHaveBeenCalled();
  expect(host.add).not.toHaveBeenCalled();
});

it("starts a new Mono's conversation with Auto permissions in the home folder, once", async () => {
  const monoId = createMono(["/project"]).id;
  const host = {
    home: vi.fn().mockResolvedValue("/home"),
    load: vi.fn(),
    create: vi.fn(createSession),
    add: vi.fn(),
  };
  const agent = (await ensureMonoSession(monoId, host))!;
  expect(agent.cwd).toBe("/home");
  expect(agent.runtimeMode).toBe("auto");
  expect(sessionOf(monoId)).toBe(agent.id);
  expect(host.add).toHaveBeenCalledExactlyOnceWith(agent);
  host.load.mockResolvedValue(agent);
  expect(await ensureMonoSession(monoId, host)).toBe(agent);
  expect(host.create).toHaveBeenCalledOnce();
  expect(host.add).toHaveBeenCalledOnce();
});

it("marks a Mono's chat as a first mate, including one already open", async () => {
  const agent = { ...chat("resident"), runtimeMode: "auto" as const };
  const monoId = monoFor(agent.cwd, agent.id);
  const host = {
    home: vi.fn().mockResolvedValue("/home"),
    load: vi.fn().mockResolvedValue(agent),
    create: vi.fn(createSession),
    add: vi.fn(),
  };
  expect((await ensureMonoSession(monoId, host))?.firstMate).toBe(true);
  expect(agent.firstMate).toBe(true);
  const freshId = createMono(["/work/My Project"]).id;
  const created = {
    home: vi.fn().mockResolvedValue("/home/My Project"),
    load: vi.fn(),
    create: vi.fn(createSession),
    add: vi.fn(),
  };
  const session = await ensureMonoSession(freshId, created);
  expect(session?.firstMate).toBe(true);
  expect(session?.cwd).toBe("/home/My Project");
});

it("marks a room chat as a first mate, and drops it when the Mono was removed", async () => {
  const monoId = createMono().id;
  const host = {
    home: vi.fn().mockResolvedValue("/home/My Project"),
    load: vi.fn(),
    create: vi.fn(createSession),
    add: vi.fn(),
  };
  const session = await ensureMonoRoomSession(monoId, "room", "conv", host);
  expect(session?.firstMate).toBe(true);
  let during: () => void = () => undefined;
  const late = {
    home: vi.fn(async () => {
      during();
      return "/home";
    }),
    load: vi.fn(),
    create: vi.fn(createSession),
    add: vi.fn(),
  };
  const gone = createMono().id;
  during = () => removeMono(gone);
  expect(await ensureMonoRoomSession(gone, "room", "conv", late)).toBeUndefined();
  expect(late.add).not.toHaveBeenCalled();
});

it("opens nothing for a Mono that no longer exists", async () => {
  const host = {
    home: vi.fn().mockResolvedValue("/home"),
    load: vi.fn(),
    create: vi.fn(createSession),
    add: vi.fn(),
  };
  expect(await ensureMonoSession("gone", host)).toBeUndefined();
  expect(host.create).not.toHaveBeenCalled();
});

it("shares concurrent first opens of the same Mono", async () => {
  const monoId = createMono().id;
  let resolveHome!: (path: string) => void;
  const home = new Promise<string>((resolve) => {
    resolveHome = resolve;
  });
  const host = {
    home: vi.fn(() => home),
    load: vi.fn(),
    create: vi.fn(createSession),
    add: vi.fn(),
  };
  const first = ensureMonoSession(monoId, host);
  const second = ensureMonoSession(monoId, host);
  resolveHome("/home");
  const [one, two] = await Promise.all([first, second]);
  expect(one).toBe(two);
  expect(sessionOf(monoId)).toBe(one!.id);
  expect(host.home).toHaveBeenCalledOnce();
  expect(host.create).toHaveBeenCalledOnce();
  expect(host.add).toHaveBeenCalledOnce();
});

it("allows retrying an open after the home lookup fails", async () => {
  const monoId = createMono().id;
  const host = {
    home: vi
      .fn()
      .mockRejectedValueOnce(new Error("Not ready"))
      .mockResolvedValue("/home"),
    load: vi.fn(),
    create: vi.fn(createSession),
    add: vi.fn(),
  };
  await expect(ensureMonoSession(monoId, host)).rejects.toThrow("Not ready");
  expect((await ensureMonoSession(monoId, host))!.cwd).toBe("/home");
  expect(host.add).toHaveBeenCalledOnce();
});

it("deletes the Mono's chat before replacing it with an empty provider session", async () => {
  const current = {
    ...chat("resident"),
    runtimeMode: "auto-accept-edits" as const,
    busy: true,
    providerSessionId: "old-provider",
    providerAccountId: "old-account",
    blocks: [
      { id: "message", role: "user" as const, text: "Old conversation" },
    ],
    queuedMessages: [
      { id: "queued", text: "Old queued message", attachments: [] },
    ],
    context: { used: 90_000 },
  };
  const monoId = monoFor(current.cwd, current.id);
  const otherId = monoFor("/other", "other-mono");
  saveMonoName(monoId, "Broski");
  const files = { soulHash: "soul", memoryHash: "memory" };
  recordAgentContext(current.id, current.providerSessionId, files);
  recordAgentContext("other-mono", "other-provider", files);
  const rotation = {
    at: 1,
    reason: "context" as const,
    earlier: ["Old conversation"],
  };
  saveMonoRotation(current.id, rotation);
  saveMonoRotation("other-mono", rotation);

  const stopped = { ...current, busy: false };
  const stop = vi.fn(async () => stopped);
  const remove = vi.fn(async () => {
    expect(stop).toHaveBeenCalledExactlyOnceWith(current.id);
    expect(sessionOf(monoId)).toBe(current.id);
  });
  const replace = vi.fn();
  const fresh = await resetMonoSession(current, { stop, remove, replace });

  expect(remove).toHaveBeenCalledExactlyOnceWith(stopped);
  expect(replace).toHaveBeenCalledExactlyOnceWith(fresh);
  expect(fresh.id).not.toBe(current.id);
  expect(fresh.blocks).toEqual([]);
  expect(fresh.providerSessionId).toBeUndefined();
  expect(fresh.providerAccountId).toBeUndefined();
  expect(fresh.queuedMessages).toBeUndefined();
  expect(fresh.context).toBeUndefined();
  expect(fresh).toMatchObject({
    cwd: current.cwd,
    harness: current.harness,
    model: current.model,
    modelSettings: current.modelSettings,
    runtimeMode: current.runtimeMode,
  });
  expect(sessionOf(monoId)).toBe(fresh.id);
  expect(findMono(monoId)?.name).toBe("Broski");
  expect(loadMonoRotation(current.id)).toBeUndefined();
  expect(
    planAgentContext(current.id, current.providerSessionId, files),
  ).toEqual({ soul: true, memory: true });
  expect(sessionOf(otherId)).toBe("other-mono");
  expect(loadMonoRotation("other-mono")).toEqual(rotation);
  expect(planAgentContext("other-mono", "other-provider", files)).toEqual({
    soul: false,
    memory: false,
  });
});

it("keeps the original chat and context if deletion fails", async () => {
  const current = chat("resident");
  const monoId = monoFor(current.cwd, current.id);
  const rotation = {
    at: 1,
    reason: "idle" as const,
    earlier: ["Keep this conversation"],
  };
  saveMonoRotation(current.id, rotation);
  const stop = vi.fn(async () => current);
  const remove = vi.fn().mockRejectedValue(new Error("Storage unavailable"));
  const replace = vi.fn();
  await expect(
    resetMonoSession(current, { stop, remove, replace }),
  ).rejects.toThrow("Storage unavailable");
  expect(sessionOf(monoId)).toBe(current.id);
  expect(loadMonoRotation(current.id)).toEqual(rotation);
  expect(replace).not.toHaveBeenCalled();
});

it("does not delete a conversation when stopping it fails", async () => {
  const current = chat("resident");
  const monoId = monoFor(current.cwd, current.id);
  const stop = vi.fn().mockRejectedValue(new Error("Could not stop the reply"));
  const remove = vi.fn();
  const replace = vi.fn();
  await expect(
    resetMonoSession(current, { stop, remove, replace }),
  ).rejects.toThrow("Could not stop the reply");
  expect(remove).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  expect(sessionOf(monoId)).toBe(current.id);
});

// SC-19 (never lose an ask, gap D1): the work a reset chat still owned goes to the fresh chat.
it("hands the reset chat's work to the fresh chat once the swap is done, and only then", async () => {
  const current = chat("resident");
  const monoId = monoFor(current.cwd, current.id);
  const stopped = { ...current, busy: false, title: "Planning" };
  const order: string[] = [];
  const replace = vi.fn(() => order.push("replace"));
  const moveWork = vi.fn(async (old: typeof current, fresh: typeof current) => {
    order.push("move");
    // By now the Mono's chat is the fresh one, and the swap is in place.
    expect(sessionOf(monoId)).toBe(fresh.id);
    expect(old.id).toBe(current.id);
  });
  const fresh = await resetMonoSession(current, {
    stop: async () => stopped,
    remove: async () => undefined,
    replace,
    moveWork,
  });
  expect(moveWork).toHaveBeenCalledExactlyOnceWith(stopped, fresh);
  expect(order).toEqual(["replace", "move"]);
});

it("moves no work when the reset fails before the new chat is in place", async () => {
  const current = chat("resident");
  monoFor(current.cwd, current.id);
  const moveWork = vi.fn(async () => undefined);
  await expect(
    resetMonoSession(current, {
      stop: async () => current,
      remove: vi.fn().mockRejectedValue(new Error("Storage unavailable")),
      replace: vi.fn(),
      moveWork,
    }),
  ).rejects.toThrow("Storage unavailable");
  expect(moveWork).not.toHaveBeenCalled();
});

it("never undoes a reset because the work could not be moved: the failure is logged", async () => {
  const current = chat("resident");
  const monoId = monoFor(current.cwd, current.id);
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const fresh = await resetMonoSession(current, {
    stop: async () => current,
    remove: async () => undefined,
    replace: vi.fn(),
    moveWork: vi.fn().mockRejectedValue(new Error("database is locked")),
  });
  expect(sessionOf(monoId)).toBe(fresh.id);
  expect(logged).toHaveBeenCalledOnce();
  logged.mockRestore();
});

it("leaves ordinary tabs, their selection, and their sessions untouched", () => {
  const session = chat("blank");
  const tab = newTab(session.id);
  const tabs = [tab];
  const sessions = [session];
  const create = vi.fn(createSession);
  expect(
    detachMonoTabs(tabs, sessions, tab.id, session.cwd, create),
  ).toBeUndefined();
  expect(tabs).toEqual([tab]);
  expect(sessions).toEqual([session]);
  expect(create).not.toHaveBeenCalled();
});

it("restores New session when the earlier agent tab was the project's only tab", () => {
  const agent = chat("resident");
  monoFor(agent.cwd, agent.id);
  const oldTab = newTab(agent.id);
  const migration = detachMonoTabs(
    [oldTab],
    [agent],
    oldTab.id,
    agent.cwd,
    createSession,
  )!;
  expect(migration.agentViewId).toBe(agent.id);
  expect(migration.tabs).toHaveLength(1);
  const blank = migration.addedSessions[0];
  expect(blank.blocks).toEqual([]);
  expect(blank.cwd).toBe(agent.cwd);
  expect(leafIds(migration.tabs[0].layout)).toEqual([blank.id]);
  expect(migration.activeTabId).toBe(migration.tabs[0].id);
  expect(
    planWorkspaceTabClose({
      tabs: migration.tabs,
      sessions: [agent, blank],
      closingTabId: migration.activeTabId,
      scope: "project",
    }),
  ).toEqual({ action: "keep" });
});

it("keeps existing session tabs and restores their original close rules", () => {
  const agent = chat("resident");
  const first = chat("first");
  const second = chat("second");
  monoFor(agent.cwd, agent.id);
  const firstTab = newTab(first.id);
  const secondTab = newTab(second.id);
  const oldAgentTab = newTab(agent.id);
  const sessions = [first, second, agent];
  const migration = detachMonoTabs(
    [firstTab, secondTab, oldAgentTab],
    sessions,
    oldAgentTab.id,
    agent.cwd,
    createSession,
  )!;
  expect(migration.tabs).toEqual([firstTab, secondTab]);
  expect(migration.tabs[0]).toBe(firstTab);
  expect(migration.addedSessions).toEqual([]);
  expect(migration.activeTabId).toBe(firstTab.id);
  expect(
    planWorkspaceTabClose({
      tabs: migration.tabs,
      sessions,
      closingTabId: secondTab.id,
      scope: "project",
    }),
  ).toEqual({ action: "close", nextActiveTabId: firstTab.id });
  expect(
    planWorkspaceTabClose({
      tabs: [firstTab],
      sessions,
      closingTabId: firstTab.id,
      scope: "project",
    }),
  ).toEqual({ action: "keep" });
});

it("preserves files and ordinary panes from a split agent tab", () => {
  const agent = chat("resident");
  monoFor(agent.cwd, agent.id);
  const oldTab = newTab(agent.id);
  oldTab.layout = splitPane(oldTab.layout, agent.id, "right", "file-pane");
  oldTab.editorPanes = [
    {
      id: "file-pane",
      activeFileId: "file",
      files: [{ id: "file", path: "/project/file.ts", cwd: agent.cwd }],
    },
  ];
  const migration = detachMonoTabs(
    [oldTab],
    [agent],
    oldTab.id,
    agent.cwd,
    createSession,
  )!;
  expect(migration.tabs[0].id).toBe(oldTab.id);
  expect(leafIds(migration.tabs[0].layout)).toEqual(["file-pane"]);
  expect(migration.tabs[0].focusedId).toBe("file-pane");
  expect(migration.tabs[0].editorPanes).toBe(oldTab.editorPanes);
  expect(migration.addedSessions).toEqual([]);
});

it("restores a blank tab for a background project without switching the active tab", () => {
  const agent = chat("resident", "/background");
  const current = chat("current", "/foreground");
  monoFor(agent.cwd, agent.id);
  const active = newTab(current.id);
  const migration = detachMonoTabs(
    [active, newTab(agent.id)],
    [current, agent],
    active.id,
    current.cwd,
    createSession,
  )!;
  expect(migration.activeTabId).toBe(active.id);
  expect(migration.agentViewId).toBeUndefined();
  expect(migration.tabs[0]).toBe(active);
  expect(migration.addedSessions[0].cwd).toBe(agent.cwd);
});

it("a setup import's engine and model are where a Mono's new conversation starts", async () => {
  addMono({ id: "builder", name: "Builder", mascot: "robot", color: "x", projects: [], ...engineFieldsOf({ harness: "opencode", model: "big-model" }) });
  const host = { home: vi.fn().mockResolvedValue("/home"), load: vi.fn(), create: vi.fn((cwd: string) => newSession("claude", cwd)), add: vi.fn() };
  const session = await ensureMonoSession("builder", host);
  // The model goes through the engine's own resolver (an unknown one becomes that engine's default).
  expect(session).toMatchObject({ harness: "opencode", model: newSession("opencode", "/home", "big-model").model, runtimeMode: "auto", cwd: "/home" });
  expect(monoEngine(findMono("builder")!)).toEqual({ harness: "opencode", model: "big-model" });
  expect(parseMonoEngine({ harness: "Bad Id!" })).toBeUndefined();
  expect(parseMonoEngine({ harness: "codex", model: " " })).toEqual({ harness: "codex" });
  expect(parseMonoEngine("codex")).toEqual({ harness: "codex" });
});

it("a Mono with its own engine starts its chat there; an unknown engine or none uses the app's default", async () => {
  const host = (added: string[]) => ({
    home: async () => "/home",
    load: async () => undefined,
    create: createSession, // the app's default here is Codex
    add: (session: { harness: string }) => added.push(session.harness),
  });
  const { addMono } = await import("./mono");
  addMono({ id: "cos", name: "Chief of Staff", mascot: "robot", color: "x", projects: [], engine: "claude" });
  addMono({ id: "odd", name: "Odd", mascot: "robot", color: "x", projects: [], engine: "toString" });
  addMono({ id: "plain", name: "Plain", mascot: "robot", color: "x", projects: [] });
  const added: string[] = [];
  const cos = await ensureMonoSession("cos", host(added));
  expect(cos).toMatchObject({ harness: "claude", cwd: "/home", runtimeMode: "auto" });
  expect(findMono("cos")).toMatchObject({ engine: "claude", sessionId: cos?.id });
  expect((await ensureMonoSession("odd", host(added)))?.harness).toBe("codex");
  expect((await ensureMonoSession("plain", host(added)))?.harness).toBe("codex");
  expect(added).toEqual(["claude", "codex", "codex"]);
});
