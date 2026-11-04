// @vitest-environment happy-dom
// No team is seeded. Souls, memory, project ties and add-ons stay empty, and a mono that is already there is left alone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addMono, findMono, listMonos } from "../../monos/model/mono";
import { DEFAULT_TEAM, ensureBuiltInMonos } from "./builtInMonos";
import { getChat, leadershipChatId } from "./hubChats";
import { addTeamAddon, noteTeamEngines, seatLeadershipTeams, seedTeamFiles, seatedTeam, tieTeamToProjects } from "./hubTeam";
import { PLAIN_SOULS, TEAM_SOULS, teamMemorySeed } from "./teamSouls";
import type { HubProject } from "./types";

const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: "/p/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/p/hivra" },
  { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "gauge", folder: "/p/monocode-hub" },
];
const GLOBAL_ASH: HubProject = { id: "ash", name: "How Ash works", shortName: "Harness", iconShape: "gauge", folder: "/p/exo-cc-studio" };

function files(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const read = vi.fn(async (id: string, path: string) => ({ text: store.get(`${id}/${path}`) ?? null, hash: store.get(`${id}/${path}`) ?? "" }));
  const write = vi.fn(async (id: string, path: string, text: string) => void store.set(`${id}/${path}`, text));
  return { store, read, write };
}

beforeEach(() => localStorage.clear());

describe("nothing is seeded for a team", () => {
  it("ships no souls and no starting memory", () => {
    expect(TEAM_SOULS).toEqual({});
    expect(PLAIN_SOULS).toEqual({});
    expect(teamMemorySeed("ada")).toBe("");
    expect(teamMemorySeed("")).toBe("");
    expect(DEFAULT_TEAM).toEqual([]);
  });

  it("a launch adds nobody, and a mono that is already there keeps its soul", async () => {
    addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [], instructions: "# Soul\n\nMine.\n" });
    expect(ensureBuiltInMonos()).toBe(0);
    expect(listMonos()).toHaveLength(1);
    expect(findMono("ada")?.instructions).toBe("# Soul\n\nMine.\n");
    expect(seatedTeam()).toEqual([]);
    const own = "# Soul\n\nMine.\n";
    const f = files({ "ada/SOUL.md": own, "ada/MEMORY.md": "- a fact\n" });
    expect(await seedTeamFiles(f.read, f.write)).toEqual([]);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.store.get("ada/SOUL.md")).toBe(own);
    expect(await seedTeamFiles(f.read, f.write)).toEqual([]);
  });

  it("a read that throws is not a reason to write, and an empty id writes nothing", async () => {
    const failing = vi.fn(async () => {
      throw new Error("no backend");
    });
    expect(await seedTeamFiles(failing, failing)).toEqual([]);
    expect(failing).not.toHaveBeenCalled();
    expect(addTeamAddon("")).toBeUndefined();
    expect(addTeamAddon("dee", PROJECTS)).toBeUndefined();
    expect(listMonos()).toEqual([]);
  });

  it("does not tie anyone to a project, including the global memory, and does not note an engine", () => {
    addMono({ id: "ed", name: "Ed", mascot: "robot", color: "x", projects: [] });
    addMono({ id: "cam", name: "Cam", mascot: "robot", color: "x", projects: [], engine: "codex" });
    const register = vi.fn(async () => undefined);
    expect(tieTeamToProjects([...PROJECTS, GLOBAL_ASH], register)).toEqual([]);
    expect(register).not.toHaveBeenCalled();
    expect(findMono("ed")?.projects).toEqual([]);
    expect(noteTeamEngines()).toEqual([]);
    expect(findMono("ed")?.engine).toBeUndefined();
    expect(findMono("cam")?.engine).toBe("codex");
    seatLeadershipTeams([...PROJECTS, GLOBAL_ASH]);
    expect(getChat(leadershipChatId("ash"))).toBeUndefined();
    for (const project of PROJECTS) expect(getChat(leadershipChatId(project.id))?.memberIds ?? []).toEqual([]);
  });

  it("does not write a memory file on launch, and does not touch one that is already there", async () => {
    const team = await import("./hubTeam");
    addMono({ id: "ed", name: "Ed", mascot: "robot", color: "x", projects: [] });
    const f = files({ "ed/memory/ash-asks.md": "- a person's own line\n" });
    expect(await team.seedFrankAshAsks(f.read, f.write)).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.store.get("ed/memory/ash-asks.md")).toBe("- a person's own line\n");
    const empty = files();
    expect(await team.seedFrankAshAsks(empty.read, empty.write)).toBe(false);
    expect(empty.store.size).toBe(0);
  });
});
