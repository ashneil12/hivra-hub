// @vitest-environment happy-dom
// Teams of named Monos: Ash makes a team (its room is a hub group chat) and its Monos (name, SOUL from a brief, engine,
// projects, connectors); an agent can only propose a Mono, which waits for Ash's okay and makes nothing until then.
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      writeSoul: async (id: string, soul: string) => void souls.set(id, soul),
      setConnectors: async (id: string, ids: string[]) => void connectorChoices.set(id, ids),
      addToRoom: (chat: string, id: string) => void rooms.push([chat, id]),
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
      { monoId: "alfred", name: "Alfred" },
    );
    expect(proposal.status).toBe("pending");
    expect(proposal.teamName).toBe("Marketing");
    expect(mono.listMonos().map((m) => m.id)).toEqual(before);
    expect(teams.listTeams()).toEqual([]);
    const row = waiting.setupItems().find((i) => i.id === `mono-proposal:${proposal.id}`)!;
    expect(row).toMatchObject({ title: "Alfred proposes a new Mono: Maya", actionLabel: "Review" });
    expect(row.detail).toContain("Marketing");
    expect(() => teams.proposeMono({ spec: { ...proposal.spec } }, { name: "frank" })).toThrow(/already waiting/);

    const made = await teams.approveProposal(proposal.id, ["hivra"], fake.deps);
    expect(mono.findMono(made.id)?.name).toBe("Maya");
    const team = teams.listTeams().find((t) => t.name === "Marketing")!;
    expect(team.memberIds).toEqual([made.id]);
    expect(teams.pendingMonoProposals()).toEqual([]);
    expect(waiting.setupItems().some((i) => i.id.startsWith("mono-proposal:"))).toBe(false);
    await expect(teams.approveProposal(proposal.id, [], fake.deps)).rejects.toThrow(/isn't waiting/);
  });

  it("Not now makes nothing", async () => {
    const teams = await import("./hubTeams");
    const mono = await import("../../monos/model/mono");
    const p = teams.proposeMono({ spec: { name: "Nope", brief: "", engine: "claude", projects: [], connectors: [] } }, { name: "Alfred" });
    teams.declineProposal(p.id);
    expect(teams.pendingMonoProposals()).toEqual([]);
    expect(mono.listMonos().some((m) => m.name === "Nope")).toBe(false);
  });

  it("app monos.propose: only a Mono, projects resolved to the hub's or its own, nothing made", async () => {
    await withHubProjects();
    localStorage.setItem(
      "monocode:mono-roster",
      JSON.stringify([{ id: "alfred", name: "Alfred", mascot: "robot", color: "hsl(0 0% 50%)", projects: [NIBBII], sessionId: "s-alfred" }]),
    );
    const { handleAgentApp } = await import("../../agent-app/model/agentApp");
    const teams = await import("./hubTeams");
    const mono = await import("../../monos/model/mono");
    const source = { id: "s-alfred", cwd: "/Users/ash" } as never;
    const host = {
      isMono: (id: string) => id === "s-alfred",
      monoOf: (id: string) => (id === "s-alfred" ? { id: "alfred", projects: [NIBBII] } : undefined),
    } as never;
    const result = (await handleAgentApp(source, "r1", "monos.propose", {
      name: "Maya", brief: "Social posts", team: "Marketing", projects: ["Hivra"], connectors: ["slack"],
    }, host)) as { status: string; proposed: string };
    expect(result).toMatchObject({ status: "pending", proposed: "Maya" });
    const [p] = teams.pendingMonoProposals();
    expect(p.proposedBy).toEqual({ monoId: "alfred", name: "Alfred" });
    expect(p.spec.projects).toEqual([HIVRA]);
    expect(p.spec.engine).toBe("claude");
    expect(mono.listMonos().map((m) => m.id)).toEqual(["alfred"]);

    // Default projects: the proposer's own.
    await handleAgentApp(source, "r2", "monos.propose", { name: "Nora" }, host);
    expect(teams.pendingMonoProposals().find((x) => x.spec.name === "Nora")!.spec.projects).toEqual([NIBBII]);
    await expect(handleAgentApp(source, "r3", "monos.propose", { name: "X", projects: ["/etc"] }, host)).rejects.toThrow(/Unknown project/);
    await expect(handleAgentApp(source, "r4", "monos.propose", { name: "Y", password: "x" }, host)).rejects.toThrow(/Unknown monos.propose fields/);
    const notMono = { id: "s-other", cwd: "/" } as never;
    await expect(handleAgentApp(notMono, "r5", "monos.propose", { name: "Z" }, host)).rejects.toThrow(/Only a Mono/);
  });
});
