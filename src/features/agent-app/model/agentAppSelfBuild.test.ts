// @vitest-environment happy-dom
// The app side of the lesson tool (ash-day step 16): only a seated Mono may file one, and it lands as that Mono's row.
// And A6: a team is drafted the same way a Mono is, and only Ash's answer makes it.
import { beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";

const learn = vi.hoisted(() => vi.fn());

vi.mock("../../selfBuild/model/skillLearn", () => ({ learnSkillLesson: learn }));

beforeEach(() => {
  localStorage.clear();
  learn.mockReset();
  learn.mockResolvedValue({ skill: "reviewing-a-diff", lesson: "Read the caller.", path: "/x", note: "in" });
});

const SESSION = { id: "s1", harness: "claude", cwd: "/w" };

async function call(action: string, input: Record<string, unknown>, host: Record<string, unknown>, session: Record<string, unknown> = SESSION) {
  const { handleSelfBuild } = await import("./agentAppSelfBuild");
  const delegate = vi.fn();
  return handleSelfBuild(session as unknown as Session, action, input, host as never, delegate);
}

it("a temporary worker can't file a lesson, and neither can a worker chat's own turn", async () => {
  await expect(call("skills.learn", { skill: "a", lesson: "b" }, { isMono: () => false })).rejects.toThrow(
    "Only one of your own Monos",
  );
});

it("a seated Mono files it as itself, naming the worker whose review it came from", async () => {
  const host = {
    isMono: () => true,
    monoOf: () => ({ id: "m1", name: "Chief of Staff", projects: ["p"] }),
  };
  await expect(call("skills.learn", { skill: "reviewing-a-diff", lesson: "Read the caller first.", from: "worker 2" }, host)).resolves.toMatchObject({
    skill: "reviewing-a-diff",
  });
  expect(learn).toHaveBeenCalledWith({
    skill: "reviewing-a-diff",
    lesson: "Read the caller first.",
    from: "worker 2",
    by: "Chief of Staff",
  });
});

it("a lesson with no skill or no sentence is refused before anything is written", async () => {
  const host = { isMono: () => true, monoOf: () => ({ id: "m1", name: "Chief of Staff", projects: [] }) };
  await expect(call("skills.learn", { lesson: "Read the caller." }, host)).rejects.toThrow("skill must be");
  await expect(call("skills.learn", { skill: "reviewing-a-diff", lesson: "  " }, host)).rejects.toThrow("lesson must be");
  expect(learn).not.toHaveBeenCalled();
});

it("teams.create drafts a team and makes nothing; only draftId, after Ash answers, makes it (A6)", async () => {
  const hub = await import("../../hub/model/hubData");
  const mock = await import("../../hub/model/mockData");
  hub.setHubDataSource({
    ...mock.mockHubData,
    listProjects: () => [{ id: "hivra", name: "Hivra", folder: "/Users/ash/Projects/hivra", iconShape: "sparkles" }],
  } as never);
  const mono = await import("../../monos/model/mono");
  const postie = mono.createMono(["/Users/ash/Projects/hivra"]);
  mono.saveMonoName(postie.id, "Postie");
  const teams = await import("../../hub/model/hubTeams");
  const host = { isMono: () => true, monoOf: () => ({ id: "chief-of-staff", name: "Chief of Staff", projects: [] }) };

  const draft = (await call("teams.create", { name: "Marketing", brief: "Owns the launch.", projects: ["hivra"], members: ["Postie"] }, host)) as {
    draftId: string;
    plan: Record<string, unknown>;
    note: string;
  };
  expect(draft.plan).toEqual({ name: "Marketing", brief: "Owns the launch.", projects: ["Hivra"], members: ["Postie"] });
  expect(draft.note).toContain("Nothing is made yet");
  expect(teams.listTeams()).toEqual([]);

  // With draftId, nothing else is accepted, and Ash not having answered makes nothing.
  await expect(call("teams.create", { draftId: draft.draftId, name: "Marketing" }, host)).rejects.toThrow("send nothing else");
  await expect(call("teams.create", { draftId: draft.draftId }, host)).rejects.toThrow("hasn't answered");
  expect(teams.listTeams()).toEqual([]);

  // Ash's own message after the draft is the gate; the team and its room are made once.
  const answered = { ...SESSION, blocks: [{ role: "user", text: "yes, make it", startedAt: Date.now() + 1000 }] };
  const made = (await call("teams.create", { draftId: draft.draftId }, host, answered)) as { teamId: string; room: string; members: string[] };
  expect(made).toMatchObject({ room: "Marketing team", members: ["Postie"] });
  const team = teams.listTeams().find((t) => t.id === made.teamId)!;
  expect(team).toMatchObject({ name: "Marketing", memberIds: [postie.id] });
  expect(await call("teams.create", { draftId: draft.draftId }, host, answered)).toMatchObject({ alreadyMade: true, teamId: team.id });
  expect(teams.listTeams()).toHaveLength(1);
});
