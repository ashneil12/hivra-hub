// @vitest-environment happy-dom
// A Mono's own work and its optional team (monoTeams.ts; Ash, 20 Oct: "the mono sub chat setup is good too ... so team can
// be optional"): its own folder is made the first time it hands out work of its own and kept by its id; its team is off
// until Ash gives it one (its workers then nest in the team rather than under it in the Monos rail), and which team a
// Mono's "Open team" opens (a Lead's coding team, a Mono's own once switched on, or none).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBuiltInMonos } from "./builtInMonos";
import { ensureProjectLeads } from "./hubLeads";
import { hubSurfaceOpen, monoTeamInView, monoTeamItem } from "./hubNav";
import {
  codingTeamNamed,
  ensureMonoWorkFolder,
  forgetMonoTeam,
  isMonoWorkFolder,
  monoTeam,
  monoTeamName,
  monoTeamOn,
  monoWorkFolder,
  monoWorkOfFolder,
  resetMonoTeams,
  setMonoTeam,
  teamFor,
} from "./monoTeams";
import type { HubProject } from "./types";

const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/p/vg-game" },
  { id: "ideas", name: "Ideas", shortName: "Ideas", iconShape: "folder", folder: null },
];
const DATA = "/Users/ash/Library/Application Support/com.ash.monocode-hub/mono-teams";
const make = (monoId: string) => Promise.resolve(`${DATA}/${monoId}`);

beforeEach(() => {
  localStorage.clear();
  resetMonoTeams();
});

describe("a Mono's own folder", () => {
  it("is made the first time it hands out work of its own, in the folder the app gives, and kept by the Mono's id", async () => {
    const madeBy = vi.fn(make);
    expect(monoWorkFolder("alfred")).toBeUndefined();
    const work = await ensureMonoWorkFolder("alfred", madeBy, 1000);
    expect(work).toEqual({ monoId: "alfred", folder: `${DATA}/alfred`, createdAt: 1000, on: false });
    expect(madeBy).toHaveBeenCalledWith("alfred");
    expect(monoWorkFolder("alfred")).toBe(`${DATA}/alfred`);
    // Asked again (a folder removed by hand comes back), it is the same folder, made when it first was.
    expect(await ensureMonoWorkFolder("alfred", madeBy, 5000)).toEqual(work);
    // It survives a reload (kept on this Mac), and is found by its folder, a trailing slash or not.
    resetMonoTeams();
    expect(monoWorkFolder("alfred")).toBe(`${DATA}/alfred`);
    expect(monoWorkOfFolder(`${DATA}/alfred/`)?.monoId).toBe("alfred");
    expect(isMonoWorkFolder(`${DATA}/alfred`)).toBe(true);
    expect(isMonoWorkFolder(`${DATA}/frank`)).toBe(false);
    expect(isMonoWorkFolder(undefined)).toBe(false);
  });

  it("refuses a folder the app couldn't make, and a deleted Mono's folder is forgotten", async () => {
    await expect(ensureMonoWorkFolder("frank", async () => "")).rejects.toThrow("couldn't make a folder");
    expect(monoWorkFolder("frank")).toBeUndefined();
    await setMonoTeam("frank", true, make);
    forgetMonoTeam("frank");
    expect(monoWorkFolder("frank")).toBeUndefined();
    expect(monoTeam("frank")).toBeUndefined();
    expect(isMonoWorkFolder(`${DATA}/frank`)).toBe(false);
  });

  it("names its team after its Mono", () => {
    expect(monoTeamName("Alfred")).toBe("Alfred's team");
    expect(monoTeamName("  ")).toBe("Team");
  });
});

describe("a Mono's own team: optional, off until Ash gives it one", () => {
  it("is off by default: its own work still has its folder, but no team shows it", async () => {
    await ensureMonoWorkFolder("alfred", make);
    expect(monoTeamOn("alfred")).toBe(false);
    expect(monoTeam("alfred")).toBeUndefined();
  });

  it("switched on, makes its folder if it has none yet; switched off, keeps the folder and what is in it", async () => {
    const madeBy = vi.fn(make);
    const team = await setMonoTeam("alfred", true, madeBy, 2000);
    expect(madeBy).toHaveBeenCalledWith("alfred");
    expect(team).toEqual({ monoId: "alfred", folder: `${DATA}/alfred`, createdAt: 2000, on: true });
    expect(monoTeam("alfred")).toEqual(team);
    // Its later work keeps the team on.
    expect((await ensureMonoWorkFolder("alfred", make, 9000)).on).toBe(true);
    resetMonoTeams();
    expect(monoTeamOn("alfred")).toBe(true);
    // Off again: back to sub-chats under it in the rail; the folder (and its workers' chats) stay where they are.
    await setMonoTeam("alfred", false, madeBy);
    expect(monoTeam("alfred")).toBeUndefined();
    expect(monoWorkFolder("alfred")).toBe(`${DATA}/alfred`);
    expect(monoWorkOfFolder(`${DATA}/alfred`)?.createdAt).toBe(2000);
    // On again finds the same folder.
    expect((await setMonoTeam("alfred", true, make))?.folder).toBe(`${DATA}/alfred`);
  });

  it("is never a Lead's: a Lead's work is its coding team's", async () => {
    ensureBuiltInMonos();
    ensureProjectLeads(PROJECTS);
    await expect(setMonoTeam("vg-game-lead", true, make)).rejects.toThrow("coding team");
    expect(monoTeamOn("vg-game-lead")).toBe(false);
  });
});

describe("which team a Mono opens", () => {
  it("a Lead opens its project's coding team; another Mono its own team only while it is on; else none", async () => {
    ensureBuiltInMonos();
    ensureProjectLeads(PROJECTS);
    expect(teamFor({ id: "vg-game-lead", name: "EXO lead" }, PROJECTS)).toEqual({
      kind: "coding",
      projectId: "vg-game",
      name: "EXO coding team",
    });
    // A project with no code folder has no coding team.
    expect(teamFor({ id: "ideas-lead" }, PROJECTS)).toBeUndefined();
    // Work of its own alone gives a Mono no team: its sub-chats nest under it in the rail.
    await ensureMonoWorkFolder("alfred", make);
    expect(teamFor({ id: "alfred", name: "Alfred" }, PROJECTS)).toBeUndefined();
    await setMonoTeam("alfred", true, make);
    expect(teamFor({ id: "alfred", name: "Alfred" }, PROJECTS)).toEqual({
      kind: "mono",
      monoId: "alfred",
      folder: `${DATA}/alfred`,
      name: "Alfred's team",
    });
    await setMonoTeam("alfred", false, make);
    expect(teamFor({ id: "alfred", name: "Alfred" }, PROJECTS)).toBeUndefined();
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
