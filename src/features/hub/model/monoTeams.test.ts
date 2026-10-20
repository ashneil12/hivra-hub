// @vitest-environment happy-dom
// A Mono's own team (monoTeams.ts): made the first time it hands out work of its own, remembered by its id, found by its
// folder; and which team a Mono's "Open team" opens (a Lead's coding team, a Mono's own, or none).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBuiltInMonos } from "./builtInMonos";
import { ensureProjectLeads } from "./hubLeads";
import { hubSurfaceOpen, monoTeamInView, monoTeamItem } from "./hubNav";
import {
  codingTeamNamed,
  ensureMonoTeam,
  forgetMonoTeam,
  isMonoTeamFolder,
  monoTeam,
  monoTeamName,
  monoTeamOfFolder,
  resetMonoTeams,
  teamFor,
} from "./monoTeams";
import type { HubProject } from "./types";

const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/p/vg-game" },
  { id: "ideas", name: "Ideas", shortName: "Ideas", iconShape: "folder", folder: null },
];
const DATA = "/Users/ash/Library/Application Support/com.ash.monocode-hub/mono-teams";

beforeEach(() => {
  localStorage.clear();
  resetMonoTeams();
});

describe("a Mono's own team", () => {
  it("is made the first time it is needed, in the folder the app gives, and kept by the Mono's id", async () => {
    const make = vi.fn(async (monoId: string) => `${DATA}/${monoId}`);
    expect(monoTeam("alfred")).toBeUndefined();
    const team = await ensureMonoTeam("alfred", make, 1000);
    expect(team).toEqual({ monoId: "alfred", folder: `${DATA}/alfred`, createdAt: 1000 });
    expect(make).toHaveBeenCalledWith("alfred");
    // Asked again (a folder removed by hand comes back), it is the same team, made when it first was.
    expect(await ensureMonoTeam("alfred", make, 5000)).toEqual(team);
    // It survives a reload (kept on this Mac), and is found by its folder, a trailing slash or not.
    resetMonoTeams();
    expect(monoTeam("alfred")).toEqual(team);
    expect(monoTeamOfFolder(`${DATA}/alfred/`)?.monoId).toBe("alfred");
    expect(isMonoTeamFolder(`${DATA}/frank`)).toBe(false);
    expect(isMonoTeamFolder(undefined)).toBe(false);
  });

  it("refuses a folder the app couldn't make, and a deleted Mono's team is forgotten", async () => {
    await expect(ensureMonoTeam("frank", async () => "")).rejects.toThrow("couldn't make a folder");
    expect(monoTeam("frank")).toBeUndefined();
    await ensureMonoTeam("frank", async () => `${DATA}/frank`);
    forgetMonoTeam("frank");
    expect(monoTeam("frank")).toBeUndefined();
    expect(isMonoTeamFolder(`${DATA}/frank`)).toBe(false);
  });

  it("is named after its Mono", () => {
    expect(monoTeamName("Alfred")).toBe("Alfred's team");
    expect(monoTeamName("  ")).toBe("Team");
  });
});

describe("which team a Mono opens", () => {
  it("a Lead opens its project's coding team; another Mono its own team once it has one; else none", async () => {
    ensureBuiltInMonos();
    ensureProjectLeads(PROJECTS);
    expect(teamFor({ id: "vg-game-lead", name: "EXO lead" }, PROJECTS)).toEqual({
      kind: "coding",
      projectId: "vg-game",
      name: "EXO coding team",
    });
    // A Lead never gets a team of its own: its workers are its coding team's.
    await ensureMonoTeam("vg-game-lead", async () => `${DATA}/vg-game-lead`);
    expect(teamFor({ id: "vg-game-lead" }, PROJECTS)?.kind).toBe("coding");
    // A project with no code folder has no coding team.
    expect(teamFor({ id: "ideas-lead" }, PROJECTS)).toBeUndefined();
    expect(teamFor({ id: "alfred", name: "Alfred" }, PROJECTS)).toBeUndefined();
    await ensureMonoTeam("alfred", async () => `${DATA}/alfred`);
    expect(teamFor({ id: "alfred", name: "Alfred" }, PROJECTS)).toEqual({
      kind: "mono",
      monoId: "alfred",
      folder: `${DATA}/alfred`,
      name: "Alfred's team",
    });
  });
});

describe("a project a Mono names", () => {
  it("is its coding team when it has a code folder and a Lead on it, however the Mono names it", () => {
    ensureBuiltInMonos();
    ensureProjectLeads(PROJECTS);
    const exo = { projectId: "vg-game", leadName: "EXO lead", name: "EXO coding team" };
    for (const named of ["vg-game", "/p/vg-game", "/p/vg-game/", "EXO", "exo"]) expect(codingTeamNamed(named, PROJECTS)).toEqual(exo);
    // No code folder, no coding team; a folder that is no hub project has none either.
    expect(codingTeamNamed("ideas", PROJECTS)).toBeUndefined();
    expect(codingTeamNamed("/tmp/scratch", PROJECTS)).toBeUndefined();
    expect(codingTeamNamed(" ", PROJECTS)).toBeUndefined();
    // Ash's global memory is no project.
    expect(codingTeamNamed("ash", [...PROJECTS, { id: "ash", name: "Ash", shortName: "Ash", iconShape: "folder", folder: "/p/ash" }])).toBeUndefined();
  });
});

describe("a Mono's team in the hub's navigation", () => {
  it("is a workspace like a coding team, selected with no project", () => {
    const sel = { project: "today", item: monoTeamItem("alfred") };
    expect(sel.item).toBe("team:alfred");
    expect(monoTeamInView(sel)).toBe("alfred");
    expect(hubSurfaceOpen(sel)).toBe(false);
    expect(monoTeamInView({ project: "today", item: "inbox" })).toBeUndefined();
    expect(hubSurfaceOpen({ project: "today", item: "inbox" })).toBe(true);
    expect(hubSurfaceOpen({ project: "vg-game", item: "coding-team" })).toBe(false);
  });
});
