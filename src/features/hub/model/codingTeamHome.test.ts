// @vitest-environment happy-dom
// WP-20: one coding-team home chat per project. The Lead's existing chat, history kept.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codingTeamChatProject, noteCodingTeamChat, resetCodingTeamChats } from "./codingTeam";
import {
  beginFirstProject,
  chosenClis,
  codingTeamHomeId,
  compareAndSwapCodingTeamHome,
  deliveryDefault,
  firstLaunchChoice,
  forgetCodingTeamHome,
  planCodingTeam,
  resetCodingTeamHomes,
  saveChosenClis,
  settleCodingTeam,
  type HomeSession,
} from "./codingTeamHome";

const folder = "/Users/Ash/My Projects/моон";
const project = { id: "field-notes", name: "Field notes", shortName: "Field", folder };
const present = [
  { cli: "codex", installed: true, signedIn: true },
  { cli: "claude", installed: true, signedIn: true },
];

function session(id: string, blocks: unknown[] = [], patch: Partial<HomeSession> = {}): HomeSession {
  return { id, cwd: folder, blocks, harness: "claude", title: "claude", ...patch };
}

beforeEach(() => {
  localStorage.clear();
  resetCodingTeamChats();
  resetCodingTeamHomes();
});

describe("a new project gets one coding team", () => {
  it("marks the Lead's chat and does not make a second one", () => {
    const first = settleCodingTeam({
      project,
      sessions: [session("chat-1")],
      lead: { id: "field-notes-lead", sessionId: "chat-1" },
      present,
      newId: "do-not-use",
      probe: { githubRepo: null, ghSignedIn: false },
    });
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]).toMatchObject({ id: "chat-1", firstMate: true });
    expect(first.plan.created).toBe(false);
    expect(first.plan.homeId).toBe("chat-1");
    expect(first.plan.crewRules).toEqual([]);
    expect(first.plan.cli).toBe("claude");
    expect(codingTeamChatProject("chat-1")).toBe("field-notes");
    expect(codingTeamHomeId("field-notes")).toBe("chat-1");

    const again = settleCodingTeam({
      project,
      sessions: first.sessions,
      lead: { id: "field-notes-lead", sessionId: "chat-1" },
      present,
      newId: "another",
      probe: { ghSignedIn: false },
    });
    expect(again.changed).toBe(false);
    expect(again.sessions).toBe(first.sessions);
    expect(again.sessions.filter((row) => row.firstMate)).toHaveLength(1);
  });

  it("waits while the Lead's chat is not loaded, then keeps that chat", () => {
    const waiting = settleCodingTeam({
      project,
      sessions: [],
      lead: { id: "field-notes-lead", sessionId: "hist" },
      present: [],
      newId: "blank",
      probe: { ghSignedIn: false },
    });
    expect(waiting.plan.waiting).toBe(true);
    expect(waiting.plan.create).toBeUndefined();
    expect(waiting.sessions).toHaveLength(0);
    expect(codingTeamHomeId("field-notes")).toBe("hist");

    const blocks = [{ id: "b1", text: "keep me" }];
    const landed = settleCodingTeam({
      project,
      sessions: [session("hist", blocks)],
      lead: { id: "field-notes-lead", sessionId: "hist" },
      present: [],
      newId: "blank",
      probe: { ghSignedIn: false },
    });
    expect(landed.sessions).toHaveLength(1);
    expect(landed.sessions[0]?.blocks).toBe(blocks);
    expect(landed.sessions[0]?.firstMate).toBe(true);
    expect(landed.plan.created).toBe(false);
    expect(landed.plan.homeId).toBe("hist");
  });

  it("creates one chat only when there is no Lead and no chat yet", () => {
    const made = settleCodingTeam({
      project,
      sessions: [],
      present: [{ cli: "codex", installed: true, signedIn: true }],
      newId: "home-1",
      allowCreate: true,
      probe: { ghSignedIn: false },
    });
    expect(made.plan.created).toBe(true);
    expect(made.sessions).toEqual([
      { id: "home-1", cwd: folder, blocks: [], firstMate: true, harness: "codex", title: "Coding team" },
    ]);
    const again = settleCodingTeam({
      project,
      sessions: made.sessions,
      present: [],
      newId: "home-2",
      allowCreate: true,
      probe: { ghSignedIn: false },
    });
    expect(again.sessions).toHaveLength(1);
    expect(again.sessions[0]?.id).toBe("home-1");
  });

  it("does not create while a Lead exists but its chat does not", () => {
    const plan = planCodingTeam({
      project,
      sessions: [],
      lead: { id: "field-notes-lead" },
      present: [],
      newId: "blank",
      allowCreate: true,
      probe: { ghSignedIn: false },
    });
    expect(plan.waiting).toBe(true);
    expect(plan.create).toBeUndefined();
  });
});

describe("opening a project lands on its coding team", () => {
  it("the home id is the chat opening uses", () => {
    const blocks = [{ id: "b", text: "hello" }];
    const settled = settleCodingTeam({
      project,
      sessions: [session("chat-9", blocks)],
      lead: { id: "field-notes-lead", sessionId: "chat-9" },
      present,
      newId: "x",
      probe: { githubRepo: "ash/field", ghSignedIn: true },
    });
    expect(settled.plan.homeId).toBe("chat-9");
    expect(codingTeamHomeId("field-notes")).toBe("chat-9");
    expect(settled.plan.delivery).toBe("checked-pr");
  });
});

describe("a seeded Lead chat migrates with its history", () => {
  it("keeps the same chat and its blocks, and leaves other chats", () => {
    const blocks = [{ id: "b1", role: "user", text: "the save bug on mission two" }];
    const extra = session("other", [{ id: "e", text: "air dodge" }]);
    const seeded = session("hist", blocks, { title: "Fix the save" });
    const settled = settleCodingTeam({
      project: { ...project, id: "vg-game", name: "EXO", shortName: "EXO", folder: "/Users/example/Projects/vg-game" },
      sessions: [seeded, extra],
      lead: { id: "vg-game-lead", sessionId: "hist" },
      present,
      newId: "new",
      probe: { ghSignedIn: false },
    });
    expect(settled.plan.migrated).toBe(true);
    expect(settled.plan.created).toBe(false);
    expect(settled.sessions).toHaveLength(2);
    expect(settled.sessions[0]).toMatchObject({ id: "hist", title: "Fix the save", firstMate: true });
    expect(settled.sessions[0]?.blocks).toBe(blocks);
    expect(settled.sessions[1]?.firstMate).toBeUndefined();
    expect(codingTeamHomeId("vg-game")).toBe("hist");
  });

  it("adopts a noted chat when the Lead has none yet, and does not bind over an existing one", () => {
    noteCodingTeamChat("noted", "field-notes");
    const bind = vi.fn();
    const blocks = [{ id: "n", text: "from before" }];
    const settled = settleCodingTeam({
      project,
      sessions: [session("app-noted-r1"), session("noted", blocks)],
      lead: { id: "field-notes-lead" },
      notedIds: ["noted", "app-noted-r1"],
      present: [],
      newId: "x",
      probe: { ghSignedIn: false },
      bindLead: bind,
    });
    expect(settled.plan.homeId).toBe("noted");
    expect(settled.sessions.find((row) => row.id === "noted")?.blocks).toBe(blocks);
    expect(settled.sessions.find((row) => row.id === "app-noted-r1")?.firstMate).toBeUndefined();
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith("field-notes-lead", "noted");

    bind.mockClear();
    settleCodingTeam({
      project,
      sessions: settled.sessions,
      lead: { id: "field-notes-lead", sessionId: "noted" },
      notedIds: ["noted"],
      present: [],
      newId: "x",
      probe: { ghSignedIn: false },
      bindLead: bind,
    });
    expect(bind).not.toHaveBeenCalled();
  });
});

describe("two windows and bad stored values", () => {
  it("compare-and-swap keeps the first home", () => {
    expect(compareAndSwapCodingTeamHome("field-notes", undefined, "a")).toBe(true);
    expect(compareAndSwapCodingTeamHome("field-notes", undefined, "b")).toBe(false);
    expect(codingTeamHomeId("field-notes")).toBe("a");
    expect(compareAndSwapCodingTeamHome("field-notes", "a", "b")).toBe(true);
    expect(codingTeamHomeId("field-notes")).toBe("b");
  });

  it("a late settle adopts the home the other window wrote", () => {
    compareAndSwapCodingTeamHome("field-notes", undefined, "winner");
    const blocks = [{ id: "w", text: "theirs" }];
    const settled = settleCodingTeam({
      project,
      sessions: [session("winner", blocks), session("mine", [{ id: "m", text: "mine" }])],
      lead: { id: "field-notes-lead", sessionId: "mine" },
      present: [],
      newId: "x",
      probe: { ghSignedIn: false },
    });
    expect(settled.plan.homeId).toBe("winner");
    expect(settled.sessions.find((row) => row.id === "winner")?.blocks).toBe(blocks);
    expect(settled.sessions.find((row) => row.id === "winner")?.firstMate).toBe(true);
    expect(settled.sessions.find((row) => row.id === "mine")?.firstMate).toBeUndefined();
    expect(codingTeamHomeId("field-notes")).toBe("winner");
  });

  it("ignores a broken, empty or unsafe stored map", () => {
    localStorage.setItem("monocode:coding-team-home", "{");
    expect(codingTeamHomeId("field-notes")).toBeUndefined();
    resetCodingTeamHomes();
    localStorage.setItem("monocode:coding-team-home", JSON.stringify({ "../x": "a", "field-notes": "../no", ok: 1, "field-notes\r": "hist" }));
    expect(codingTeamHomeId("field-notes")).toBe("hist");
    expect(codingTeamHomeId("../x")).toBeUndefined();
  });

  it("forgets the home only when that chat is the home", () => {
    compareAndSwapCodingTeamHome("field-notes", undefined, "hist");
    forgetCodingTeamHome("other");
    expect(codingTeamHomeId("field-notes")).toBe("hist");
    forgetCodingTeamHome("hist");
    expect(codingTeamHomeId("field-notes")).toBeUndefined();
  });

  it("a project with no folder, the global project, or a bad id gets no team", () => {
    for (const row of [
      { ...project, folder: null },
      { ...project, folder: "  \r" },
      { ...project, id: "ash", folder },
      { ...project, id: "../ash", folder },
      { ...project, id: "", folder },
    ]) {
      const settled = settleCodingTeam({
        project: row,
        sessions: [session("x")],
        lead: { id: "lead", sessionId: "x" },
        present,
        newId: "n",
        allowCreate: true,
        probe: { githubRepo: "a/b", ghSignedIn: true },
      });
      expect(settled.plan.homeId).toBeNull();
      expect(settled.sessions).toHaveLength(1);
      expect(settled.sessions[0]?.firstMate).toBeUndefined();
    }
  });
});

describe("crew default and delivery default", () => {
  it("uses Claude Code when it is signed in, else the first signed-in CLI, else none", () => {
    expect(planCodingTeam({ project, sessions: [], present, newId: "n", probe: { ghSignedIn: false } }).cli).toBe("claude");
    expect(
      planCodingTeam({
        project,
        sessions: [],
        present: [
          { cli: "nope", installed: true, signedIn: true },
          { cli: "codex", installed: true, signedIn: false },
          { cli: "cursor", installed: true, signedIn: true },
        ],
        newId: "n",
        probe: { ghSignedIn: false },
      }).cli,
    ).toBe("cursor");
    expect(planCodingTeam({ project, sessions: [], present: [], newId: "n", probe: { ghSignedIn: false } }).cli).toBeNull();
  });

  it("is a checked pull request only when there is a GitHub repo and gh is signed in", () => {
    expect(deliveryDefault({ githubRepo: "ash/field", ghSignedIn: true })).toBe("checked-pr");
    expect(deliveryDefault({ githubRepo: " ash/field\r", ghSignedIn: true })).toBe("checked-pr");
    expect(deliveryDefault({ githubRepo: "ash/field", ghSignedIn: false })).toBe("local");
    expect(deliveryDefault({ githubRepo: "", ghSignedIn: true })).toBe("local");
    expect(deliveryDefault({ githubRepo: null, ghSignedIn: true })).toBe("local");
    expect(deliveryDefault({ ghSignedIn: true })).toBe("local");
  });

  it("keeps a folder path as it was given, including spaces, unicode and Windows separators", () => {
    const win = "C:\\Users\\Ash\\My Projects\\моон";
    const made = settleCodingTeam({
      project: { ...project, folder: `${win}\r` },
      sessions: [],
      present: [],
      newId: "home-1",
      allowCreate: true,
      probe: { ghSignedIn: false },
    });
    expect(made.sessions[0]?.cwd).toBe(win);
  });
});

describe("the CLIs chosen at first launch", () => {
  it("drops blanks, duplicates, unknown names and carriage returns", () => {
    expect(saveChosenClis(["claude\r", "claude", "nope", "  ", "codex", 3, "pi"])).toEqual(["claude", "codex", "pi"]);
    expect(chosenClis()).toEqual(["claude", "codex", "pi"]);
    resetCodingTeamHomes();
    expect(chosenClis()).toEqual(["claude", "codex", "pi"]);
    expect(saveChosenClis("claude")).toEqual([]);
    expect(saveChosenClis(null)).toEqual([]);
  });

  it("a group is offered and made only when a project was chosen and the box was ticked", () => {
    expect(firstLaunchChoice({ projectName: "  Field notes\r", group: true, clis: ["codex", "codex"] })).toEqual({
      projectName: "Field notes",
      group: true,
      clis: ["codex"],
    });
    expect(firstLaunchChoice({ projectName: "   ", group: true, clis: [] }).group).toBe(false);
    expect(firstLaunchChoice({ projectName: "Field notes", group: false, clis: [] }).group).toBe(false);
    expect(firstLaunchChoice({ projectName: 4, group: true, clis: {} }).projectName).toBeNull();
  });
});

describe("beginFirstProject", () => {
  it("opens the project once, and adds a group only when asked", async () => {
    const create = vi.fn(async (name: string) => ({ id: "field-notes", folder: `/tmp/${name}`, name }));
    const addGroup = vi.fn();
    const open = vi.fn();
    const result = await beginFirstProject(
      { projectName: "Field notes", group: false },
      { create, addGroup, open },
    );
    expect(result).toBe("opened");
    expect(create).toHaveBeenCalledTimes(1);
    expect(addGroup).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("field-notes");

    await beginFirstProject({ projectName: "Other", group: true }, { create, addGroup, open });
    expect(addGroup).toHaveBeenCalledWith("field-notes");
  });

  it("a failed create is not the end, and a removed project is not opened", async () => {
    const open = vi.fn();
    const addGroup = vi.fn();
    await expect(
      beginFirstProject(
        { projectName: "Field notes", group: true },
        { create: async () => { throw new Error("timed out"); }, addGroup, open },
      ),
    ).resolves.toBe("unavailable");
    expect(open).not.toHaveBeenCalled();
    expect(addGroup).not.toHaveBeenCalled();

    await beginFirstProject(
      { projectName: "Gone", group: true },
      { create: async () => ({ id: "gone", folder: "/tmp/gone" }), addGroup, open, stillThere: () => false },
    );
    expect(open).not.toHaveBeenCalled();
    expect(addGroup).not.toHaveBeenCalled();
  });

  it("two calls for the same project share one create", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const create = vi.fn(async () => {
      await gate;
      return { id: "field-notes", folder: "/tmp/field" };
    });
    const first = beginFirstProject({ projectName: "Field notes", group: false }, { create, addGroup: () => undefined, open: () => undefined });
    const second = beginFirstProject({ projectName: "Field notes", group: true }, { create, addGroup: () => undefined, open: () => undefined });
    release?.();
    await Promise.all([first, second]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
