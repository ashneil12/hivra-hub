// @vitest-environment happy-dom
// Teams of named Monos: Ash makes a team (its room is a hub group chat) and its Monos (name, SOUL from a brief, engine,
// projects, connectors); an agent can only propose a Mono, which waits for Ash's okay and makes nothing until then.
import { beforeEach, describe, expect, it, vi } from "vitest";

// These load the hub's modules fresh per test (dynamic imports): slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });
import type { HubDataSource } from "./types";

const HIVRA = "/Users/ash/Projects/hivra";
const NIBBII = "/Users/ash/Projects/nibbii";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function withHubProjects() {
  const hub = await import("./hubData");
  const mock = await import("./mockData");
  hub.setHubDataSource({
    ...mock.mockHubData,
    listProjects: () => [
      { id: "hivra", name: "Hivra", folder: HIVRA, iconShape: "sparkles" },
      { id: "nibbii", name: "Nibbii", folder: NIBBII, iconShape: "palette" },
    ],
  } as unknown as HubDataSource);
}

function fakeDeps(mono: typeof import("../../monos/model/mono")) {
  const souls = new Map<string, string>();
  const connectorChoices = new Map<string, string[]>();
  const rooms: [string, string][] = [];
  return {
    souls,
    connectorChoices,
    rooms,
    deps: {
      createMono: (projects: string[]) => mono.createMono(projects),
      name: mono.saveMonoName,
      engine: (id: string, engine: string) => void mono.updateMono(id, (m) => ({ ...m, engine })),
      writeSoul: async (id: string, soul: string) => void souls.set(id, soul),
      setConnectors: async (id: string, ids: string[]) => void connectorChoices.set(id, ids),
      addToRoom: (chat: string, id: string) => void rooms.push([chat, id]),
      discard: (id: string) => {
        connectorChoices.delete(id);
        mono.discardNewMono(id);
      },
    },
  };
}

describe("teams", () => {
  it("a team gets a room in its first project, reusing the hub's group chats", async () => {
    await withHubProjects();
    const teams = await import("./hubTeams");
    const chats = await import("./hubChats");
    const team = teams.createTeam({ name: " Marketing ", brief: "Grow Hivra and Nibbii", projects: ["hivra", "nibbii"] });
    expect(team.name).toBe("Marketing");
    const room = chats.getChat(team.roomChatId!)!;
    expect(room).toMatchObject({ projectId: "hivra", name: "Marketing team", isDefault: false, memberIds: [] });
    // It shows in Hivra's sidebar like any group chat.
    const { projectItems } = await import("./mockData");
    expect(projectItems("hivra").some((i) => i.id === `chat:${room.id}`)).toBe(true);
    expect(() => teams.createTeam({ name: "marketing", brief: "", projects: ["hivra"] })).toThrow(/already/);
    expect(() => teams.createTeam({ name: "Sales", brief: "", projects: [] })).toThrow(/at least one project/);
    expect(() => teams.createTeam({ name: "", brief: "", projects: ["hivra"] })).toThrow(/name/);
  });

  it("a team made from a draft takes its Monos in at once, and Undo/Redo take and bring back its room (A6)", async () => {
    await withHubProjects();
    const teams = await import("./hubTeams");
    const mono = await import("../../monos/model/mono");
    const chats = await import("./hubChats");
    const postie = mono.createMono([HIVRA]);
    mono.saveMonoName(postie.id, "Postie");
    // Only Monos that exist belong, once each.
    const team = teams.createTeam({ name: "Marketing", brief: "Owns the launch", projects: ["hivra"], memberIds: [postie.id, postie.id, "ghost"] });
    expect(team.memberIds).toEqual([postie.id]);
    expect(chats.getChat(team.roomChatId!)!.memberIds).toEqual([postie.id]);
    // Undo: the team and its room go; its Monos stay (they are Ash's, in the sidebar).
    const gone = teams.retireTeam(team.id)!;
    expect(gone.id).toBe(team.id);
    expect(teams.getTeam(team.id)).toBeUndefined();
    expect(chats.getChat(team.roomChatId!)).toBeUndefined();
    expect(mono.findMono(postie.id)?.name).toBe("Postie");
    expect(teams.retireTeam(team.id)).toBeUndefined();
    // Redo: the same team comes back with a fresh room and its Monos in it; a second Redo changes nothing.
    const back = teams.restoreTeam(gone);
    expect(back.id).toBe(team.id);
    expect(back.roomChatId).not.toBe(team.roomChatId);
    expect(chats.getChat(back.roomChatId!)!.memberIds).toEqual([postie.id]);
    expect(teams.restoreTeam(gone)).toBe(back);
    expect(teams.listTeams()).toHaveLength(1);
  });

  it("making a named Mono gives it its name, a SOUL from its brief, its engine, projects and only its connectors", async () => {
    await withHubProjects();
    const teams = await import("./hubTeams");
    const mono = await import("../../monos/model/mono");
    const chats = await import("./hubChats");
    const fake = fakeDeps(mono);
    const team = teams.createTeam({ name: "Marketing", brief: "", projects: ["hivra"] });
    const before = mono.listMonos().length;
    const maya = await teams.addNamedMono(
      team.id,
      { name: "Maya", brief: "Writes and schedules our social posts.", engine: "codex", projects: [HIVRA], connectors: ["notion", "slack"] },
      { ...fake.deps, addToRoom: (chat, id) => { fake.rooms.push([chat, id]); chats.addMember(chat, id); } },
    );
    expect(mono.listMonos()).toHaveLength(before + 1);
    expect(mono.findMono(maya.id)).toMatchObject({ name: "Maya", projects: [HIVRA] });
    const soul = fake.souls.get(maya.id)!;
    expect(soul).toContain("I'm Maya, on the Marketing team");
    expect(soul).toContain("Writes and schedules our social posts.");
    expect(soul).toContain("(Notion, Slack)");
    expect(soul).toContain("show Ash the draft");
    expect(soul).toContain("## Standing instructions");
    expect(teams.monoEngine(maya.id)).toBe("codex");
    expect(fake.connectorChoices.get(maya.id)).toEqual(["notion", "slack"]);
    expect(teams.getTeam(team.id)!.memberIds).toEqual([maya.id]);
    expect(chats.getChat(team.roomChatId!)!.memberIds).toEqual([maya.id]);
    expect(teams.teamOf(maya.id)?.id).toBe(team.id);

    await expect(teams.addNamedMono(team.id, { name: "maya", brief: "", engine: "claude", projects: [], connectors: [] }, fake.deps)).rejects.toThrow(/already exists/);
    await expect(teams.addNamedMono(team.id, { name: "Zed", brief: "", engine: "nope" as never, projects: [], connectors: [] }, fake.deps)).rejects.toThrow(/engine/);
    await expect(teams.addNamedMono(team.id, { name: "Zed", brief: "", engine: "claude", projects: [], connectors: ["made-up"] }, fake.deps)).rejects.toThrow(/No connector/);
  });

  it("its first chat starts on the engine it was made with", async () => {
    const teams = await import("./hubTeams");
    const mono = await import("../../monos/model/mono");
    const { ensureMonoSession } = await import("../../monos/model/monoWorkspace");
    const { newSession } = await import("../../sessions/model/session");
    const fake = fakeDeps(mono);
    const made = await teams.addNamedMono(undefined, { name: "Cody", brief: "", engine: "codex", projects: [], connectors: [] }, fake.deps);
    const session = await ensureMonoSession(made.id, {
      home: async () => "/Users/ash",
      load: async () => null,
      create: (cwd) => newSession("claude", cwd),
      add: () => undefined,
    });
    expect(session?.harness).toBe("codex");
    expect(session?.runtimeMode).toBe("auto");
    // Any other Mono keeps the default engine.
    const plain = mono.createMono([]);
    const other = await ensureMonoSession(plain.id, {
      home: async () => "/Users/ash",
      load: async () => null,
      create: (cwd) => newSession("claude", cwd),
      add: () => undefined,
    });
    expect(other?.harness).toBe("claude");
  });
});

describe("a Mono proposed by an agent needs Ash's okay", () => {
  it("files a proposal that makes nothing, shows on Today's Setup, and only Approve makes the Mono", async () => {
    await withHubProjects();
    const teams = await import("./hubTeams");
    const mono = await import("../../monos/model/mono");
    const waiting = await import("./waiting");
    const fake = fakeDeps(mono);
    const before = mono.listMonos().map((m) => m.id);
    const proposal = teams.proposeMono(
      { team: "Marketing", spec: { name: "Maya", brief: "Social posts", engine: "claude", projects: [HIVRA], connectors: [] } },
      { monoId: "cam", name: "Alfred" },
    );
    expect(proposal.status).toBe("pending");
    expect(proposal.teamName).toBe("Marketing");
    expect(mono.listMonos().map((m) => m.id)).toEqual(before);
    expect(teams.listTeams()).toEqual([]);
    const row = waiting.setupItems().find((i) => i.id === `mono-proposal:${proposal.id}`)!;
    expect(row).toMatchObject({ title: "Alfred proposes a new Mono: Maya", actionLabel: "Review" });
    expect(row.detail).toContain("Marketing");
    expect(() => teams.proposeMono({ spec: { ...proposal.spec } }, { name: "ed" })).toThrow(/already waiting/);

    const made = await teams.approveProposal(proposal.id, ["hivra"], fake.deps);
    expect(mono.findMono(made.id)?.name).toBe("Maya");
    const team = teams.listTeams().find((t) => t.name === "Marketing")!;
    expect(team.memberIds).toEqual([made.id]);
    expect(teams.pendingMonoProposals()).toEqual([]);
    expect(waiting.setupItems().some((i) => i.id.startsWith("mono-proposal:"))).toBe(false);
    await expect(teams.approveProposal(proposal.id, [], fake.deps)).rejects.toThrow(/isn't waiting/);
  });

  it("an Approve that fails part way leaves no half-made Mono, and Approve again works", async () => {
    await withHubProjects();
    const teams = await import("./hubTeams");
    const mono = await import("../../monos/model/mono");
    const fake = fakeDeps(mono);
    const removedByAsh = () => Object.keys(localStorage).filter((key) => key.includes("removed")).map((key) => localStorage.getItem(key));
    const removedBefore = removedByAsh();
    const before = mono.listMonos().map((m) => m.id);
    const proposal = teams.proposeMono(
      { team: "Marketing", spec: { name: "Maya", brief: "Social posts", engine: "claude", projects: [HIVRA], connectors: [] } },
      { name: "Alfred" },
    );
    for (const broken of ["writeSoul", "setConnectors"] as const) {
      const failing = { ...fake.deps, [broken]: async () => { throw new Error("disk full"); } };
      await expect(teams.approveProposal(proposal.id, ["hivra"], failing)).rejects.toThrow("disk full");
      // No Mono is left without a connector choice (which would mean everything its projects allow).
      expect(mono.listMonos().map((m) => m.id)).toEqual(before);
      expect(fake.connectorChoices.size).toBe(0);
      expect(teams.pendingMonoProposals().map((p) => p.id)).toEqual([proposal.id]);
    }
    // A rollback is not Ash removing a Mono: nothing is recorded as removed by him.
    expect(removedByAsh()).toEqual(removedBefore);
    const made = await teams.approveProposal(proposal.id, ["hivra"], fake.deps);
    expect(mono.findMono(made.id)?.name).toBe("Maya");
    expect(fake.connectorChoices.get(made.id)).toEqual([]);
    expect(teams.listTeams().find((t) => t.name === "Marketing")?.memberIds).toEqual([made.id]);
  });

  it("Not now makes nothing", async () => {
    const teams = await import("./hubTeams");
    const mono = await import("../../monos/model/mono");
    const p = teams.proposeMono({ spec: { name: "Nope", brief: "", engine: "claude", projects: [], connectors: [] } }, { name: "Alfred" });
    teams.declineProposal(p.id);
    expect(teams.pendingMonoProposals()).toEqual([]);
    expect(mono.listMonos().some((m) => m.name === "Nope")).toBe(false);
  });

  it("one way to make a Mono: app monos.propose is refused toward mono_create, nothing filed, and an old waiting proposal is closed", async () => {
    localStorage.setItem("monocode:hub-teams", JSON.stringify({ teams: [], proposals: [
      { id: "p-old", spec: { name: "Maya", brief: "", engine: "claude", projects: [], connectors: [] }, proposedBy: { name: "Alfred" }, status: "pending", at: 1 },
    ] }));
    vi.resetModules();
    const { handleAgentApp, MONO_ONE_WAY } = await import("../../agent-app/model/agentApp");
    const teams = await import("./hubTeams");
    expect(teams.pendingMonoProposals()).toEqual([]);
    const source = { id: "s-cam", cwd: "/Users/ash" } as never;
    const host = { isMono: (id: string) => id === "s-cam", monoOf: () => ({ id: "cam", projects: [] }) } as never;
    await expect(handleAgentApp(source, "r1", "monos.propose", { name: "Nora" }, host)).rejects.toThrow(/one way to make a Mono: mono_create/);
    expect(MONO_ONE_WAY).toMatch(/Ash/);
    expect(teams.pendingMonoProposals()).toEqual([]);
  });
});
