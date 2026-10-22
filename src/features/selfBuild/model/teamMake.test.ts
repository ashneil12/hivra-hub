// @vitest-environment happy-dom
// A6: a Mono can propose a team for an area, the way it proposes a Mono. The draft makes nothing, Ash's yes in the
// chat is the only gate, the team shows in Teams with its room, and Undo in Bot changes takes the team and room away
// while its Monos stay.
import { beforeEach, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const HIVRA = "/Users/ash/Projects/hivra";
const NIBBII = "/Users/ash/Projects/nibbii";
const CALLER = { monoId: "chief-of-staff", name: "Chief of Staff" };

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function app() {
  const hub = await import("../../hub/model/hubData");
  const mock = await import("../../hub/model/mockData");
  hub.setHubDataSource({
    ...mock.mockHubData,
    listProjects: () => [
      { id: "hivra", name: "Hivra", folder: HIVRA, iconShape: "sparkles" },
      { id: "nibbii", name: "Nibbii", folder: NIBBII, iconShape: "palette" },
    ],
  } as never);
  const mono = await import("../../monos/model/mono");
  const make = await import("./teamMake");
  const teams = await import("../../hub/model/hubTeams");
  const chats = await import("../../hub/model/hubChats");
  const changes = await import("../../hub/model/botChanges");
  const named = (name: string) => {
    const m = mono.createMono([HIVRA]);
    mono.saveMonoName(m.id, name);
    return m;
  };
  const postie = named("Postie");
  const scout = named("Scout");
  return { mono, make, teams, chats, changes, postie, scout };
}

const BRIEF = "Owns the launch: the site, the posts and the follow-up.";

it("a drafted team makes nothing: no team, no room, and its card waits in the chat it was drafted in", async () => {
  const a = await app();
  const draft = a.make.draftTeam(
    { name: "Marketing", brief: BRIEF, projects: ["hivra"], members: ["Postie", a.scout.id] },
    CALLER,
    1000,
    { session: "cos-chat" },
  );
  expect(draft.plan).toEqual({
    name: "Marketing",
    brief: BRIEF,
    projects: ["Hivra"],
    members: ["Postie", "Scout"],
  });
  expect(draft.note).toMatch(/Nothing is made yet/);
  expect(draft.note).toMatch(/call team_create with only draftId/);
  expect(a.teams.listTeams()).toEqual([]);
  expect(a.chats.allChats().some((c) => c.name === "Marketing team")).toBe(false);
  // Its card sits in that chat and nowhere else.
  const waiting = a.make.waitingTeamDrafts();
  expect(waiting.map((d) => d.id)).toEqual([draft.draftId]);
  expect(a.make.teamDraftsIn(waiting, { session: "cos-chat" })).toHaveLength(1);
  expect(a.make.teamDraftsIn(waiting, { session: "other" })).toHaveLength(0);
});

it("the team is made only after Ash answers, once, with its room and Monos in it, and Undo takes it away", async () => {
  const a = await app();
  const draft = a.make.draftTeam(
    { name: "Marketing", brief: BRIEF, projects: ["hivra", "nibbii"], members: ["Postie"] },
    CALLER,
    1000,
  );
  let spoke = false;
  const host = { ashSpokeSince: () => spoke };
  await expect(a.make.makeDraftedTeam(draft.draftId, CALLER, host)).rejects.toThrow(/hasn't answered/);
  expect(a.teams.listTeams()).toEqual([]);
  expect(a.chats.allChats().some((c) => c.name === "Marketing team")).toBe(false);

  spoke = true;
  const made = await a.make.makeDraftedTeam(draft.draftId, CALLER, host);
  const team = a.teams.listTeams().find((t) => t.id === made.teamId)!;
  expect(team).toMatchObject({ name: "Marketing", brief: BRIEF, projects: ["hivra", "nibbii"], memberIds: [a.postie.id] });
  const room = a.chats.getChat(team.roomChatId!)!;
  expect(room).toMatchObject({ projectId: "hivra", name: "Marketing team" });
  expect(room.memberIds).toEqual([a.postie.id]);
  expect(made).toMatchObject({ made: "Marketing", room: "Marketing team", members: ["Postie"] });
  expect(a.make.waitingTeamDrafts().some((d) => d.id === draft.draftId)).toBe(false);

  // The same draft never makes a second one.
  expect(await a.make.makeDraftedTeam(draft.draftId, CALLER, host)).toMatchObject({ alreadyMade: true, teamId: team.id });
  expect(a.teams.listTeams().filter((t) => t.name === "Marketing")).toHaveLength(1);

  const row = a.changes.botChangesSince(0).find((c) => c.madeTeam?.team.id === team.id)!;
  expect(row.bot).toBe("Chief of Staff");
  expect(row.line).toContain("made a new team, Marketing (1 Mono)");
  // Undo: the team and its room go; its Monos stay.
  await a.changes.undoBotChange([row.id]);
  expect(a.teams.getTeam(team.id)).toBeUndefined();
  expect(a.chats.getChat(team.roomChatId!)).toBeUndefined();
  expect(a.mono.findMono(a.postie.id)?.name).toBe("Postie");
  // Redo: the same team comes back, with a fresh room and its Monos in it.
  await a.changes.redoBotChange([row.id]);
  const back = a.teams.getTeam(team.id)!;
  expect(back.name).toBe("Marketing");
  expect(back.memberIds).toEqual([a.postie.id]);
  const backRoom = a.chats.getChat(back.roomChatId!)!;
  expect(backRoom.name).toBe("Marketing team");
  expect(backRoom.memberIds).toEqual([a.postie.id]);
});

it("only the Mono that drafted it can make it, and a card Ash waved off makes nothing", async () => {
  const a = await app();
  const host = { ashSpokeSince: () => true };
  const draft = a.make.draftTeam({ name: "Marketing", brief: BRIEF, projects: ["hivra"] }, CALLER, 1000);
  await expect(a.make.makeDraftedTeam(draft.draftId, { monoId: "someone-else" }, host)).rejects.toThrow(/No team draft/);
  expect(a.teams.listTeams()).toEqual([]);
  a.make.dismissTeamDraft(draft.draftId);
  await expect(a.make.makeDraftedTeam(draft.draftId, CALLER, host)).rejects.toThrow(/turned this card down/);
  expect(a.teams.listTeams()).toEqual([]);
  expect(a.make.waitingTeamDrafts()).toEqual([]);
});

it("names, brief and real projects and Monos are checked before anything is drafted", async () => {
  const a = await app();
  const draft = (input: Record<string, unknown>) => () => a.make.draftTeam(input, CALLER, 1000);
  expect(draft({ brief: BRIEF, projects: ["hivra"] })).toThrow(/name/);
  expect(draft({ name: "Marketing", projects: ["hivra"] })).toThrow(/brief/);
  expect(draft({ name: "Marketing", brief: BRIEF })).toThrow(/at least one project/);
  expect(draft({ name: "Marketing", brief: BRIEF, projects: ["nope"] })).toThrow(/Unknown project nope/);
  expect(draft({ name: "Marketing", brief: BRIEF, projects: ["hivra"], members: ["Ghost"] })).toThrow(/No Mono called Ghost/);
  a.teams.createTeam({ name: "Marketing", brief: "", projects: ["hivra"] });
  expect(draft({ name: "marketing", brief: BRIEF, projects: ["hivra"] })).toThrow(/already a marketing team/);
  expect(a.make.waitingTeamDrafts()).toEqual([]);
});
