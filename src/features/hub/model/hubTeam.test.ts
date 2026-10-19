// @vitest-environment happy-dom
// The leadership team made real: souls and starting memory seeded once (never over Ash's edits), engine noted per
// Mono, membership of every project (never the global `ash` memory) so the team can reach the Leads, Critiquito only
// when ticked. The Mono files are a stand-in map for the Rust mono_read / mono_save commands.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addMono, findMono, listMonos, removeMonoProject } from "../../monos/model/mono";
import { defaultSoul } from "../../monos/model/monoFiles";
import { ADDON_OFFER, DEFAULT_TEAM, ensureBuiltInMonos } from "./builtInMonos";
import { getChat, leadershipChatId } from "./hubChats";
import { addTeamAddon, noteTeamEngines, seatLeadershipTeams, seedTeamFiles, seatedTeam, tieTeamToProjects } from "./hubTeam";
import { ROOM_RULES, TEAM_SOULS } from "./teamSouls";
import { roleOf, skillsOf } from "./setupSouls";
import type { HubProject } from "./types";

const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "ghost", folder: "/p/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/p/hivra" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "palette", folder: "/p/nibbii" },
  { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "gauge", folder: "/p/monocode-hub" },
];
const GLOBAL_ASH: HubProject = { id: "ash", name: "How Ash works", shortName: "Harness", iconShape: "gauge", folder: "/p/exo-cc-studio" };
const TEAM_IDS = ["chief-of-staff", "projects-manager", "frank", "alfred"];

function files(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const read = vi.fn(async (id: string, path: string) => ({ text: store.get(`${id}/${path}`) ?? null, hash: store.get(`${id}/${path}`) ?? "" }));
  const write = vi.fn(async (id: string, path: string, text: string) => void store.set(`${id}/${path}`, text));
  return { store, read, write };
}

beforeEach(() => localStorage.clear());

describe("the team's souls", () => {
  it("each of the five has its Role line, its Skills and the room rules; none is the retired dr eggbot or mentions Grok's tools", () => {
    expect(Object.keys(TEAM_SOULS)).toEqual([...TEAM_IDS, "critiquito"]);
    for (const [id, soul] of Object.entries(TEAM_SOULS)) {
      expect(soul.startsWith("# Soul\n\n## Role\n"), id).toBe(true);
      expect(roleOf(id, soul), id).toBeTruthy();
      expect(skillsOf(soul).length, id).toBeGreaterThan(0);
      expect(soul, id).toContain(ROOM_RULES);
      expect(soul, id).not.toMatch(/notion|CreateAgent|SendToAgent|grok bot|eggbot|—/i);
    }
    expect(roleOf("Chief of Staff", TEAM_SOULS["chief-of-staff"])).toMatch(/^Ash's business partner and the Mono he talks to first/);
    expect(TEAM_SOULS.critiquito).toContain("rank the fixes by what each one costs them");
  });

  it("a clean launch's roster carries each soul until SOUL.md is written, and notes the engine (Claude Code)", () => {
    ensureBuiltInMonos();
    const roster = listMonos();
    expect(roster.map((m) => m.name)).toEqual(DEFAULT_TEAM);
    for (const m of roster) {
      expect(m.engine).toBe("claude");
      expect(m.instructions).toBe(TEAM_SOULS[m.id]);
      expect(defaultSoul(m.instructions)).toBe(TEAM_SOULS[m.id]); // a whole soul is kept as it is, not wrapped
    }
  });

  it("are written once: over a missing or untouched default soul, never over Ash's own; memory only when empty", async () => {
    addMono({ id: "chief-of-staff", name: "Chief of Staff", mascot: "robot", color: "x", projects: [] });
    addMono({ id: "frank", name: "frank", mascot: "robot", color: "x", projects: [] });
    addMono({ id: "alfred", name: "Alfred", mascot: "robot", color: "x", projects: [] });
    addMono({ id: "someone", name: "Scout", mascot: "robot", color: "x", projects: [] });
    const f = files({
      "chief-of-staff/SOUL.md": defaultSoul(), // the stub every team Mono had before
      "frank/SOUL.md": "# Soul\n\nAsh's own frank.\n",
      "frank/MEMORY.md": "- 2026-10-01 · something frank knows",
    });
    expect(await seedTeamFiles(f.read, f.write)).toEqual(["chief-of-staff", "alfred"]);
    expect(f.store.get("chief-of-staff/SOUL.md")).toBe(TEAM_SOULS["chief-of-staff"]);
    expect(f.store.get("alfred/SOUL.md")).toBe(TEAM_SOULS.alfred);
    expect(f.store.get("frank/SOUL.md")).toBe("# Soul\n\nAsh's own frank.\n");
    expect(f.store.get("frank/MEMORY.md")).toBe("- 2026-10-01 · something frank knows");
    expect(f.store.get("chief-of-staff/MEMORY.md")).toMatch(/^- 2026-10-19 · The default team is Chief of Staff, Projects Manager, frank and Alfred\./);
    expect(f.store.has("someone/SOUL.md")).toBe(false);
    // once: Ash empties CoS's soul back to the default later, and it is left as he made it
    f.store.set("chief-of-staff/SOUL.md", defaultSoul());
    f.write.mockClear();
    expect(await seedTeamFiles(f.read, f.write)).toEqual([]);
    expect(f.write).not.toHaveBeenCalled();
  });

  it("a Mono whose files can't be reached is tried again next launch", async () => {
    ensureBuiltInMonos();
    const failing = vi.fn(async () => { throw new Error("no backend"); });
    expect(await seedTeamFiles(failing, failing)).toEqual([]);
    const f = files();
    expect((await seedTeamFiles(f.read, f.write)).sort()).toEqual([...TEAM_IDS].sort());
  });

  it("team Monos made before engines were noted get Claude Code once; Ash's later change stays", () => {
    addMono({ id: "frank", name: "frank", mascot: "robot", color: "x", projects: [] });
    addMono({ id: "alfred", name: "Alfred", mascot: "robot", color: "x", projects: [], engine: "codex" });
    addMono({ id: "someone", name: "Scout", mascot: "robot", color: "x", projects: [] });
    expect(noteTeamEngines()).toEqual(["frank"]);
    expect(findMono("frank")?.engine).toBe("claude");
    expect(findMono("alfred")?.engine).toBe("codex");
    expect(findMono("someone")?.engine).toBeUndefined();
  });
});

describe("the team reaches every project", () => {
  it("each team Mono is a member of every project (never the global `ash` memory), registered in Ash OS as a member", () => {
    ensureBuiltInMonos();
    const register = vi.fn(async () => undefined);
    const tied = tieTeamToProjects([...PROJECTS, GLOBAL_ASH], register);
    expect(tied).toHaveLength(16);
    for (const id of TEAM_IDS) expect(findMono(id)?.projects).toEqual(PROJECTS.map((p) => p.folder));
    expect(register.mock.calls.some(([, project]) => project === "ash")).toBe(false);
    expect(register).toHaveBeenCalledWith("chief-of-staff", "hub");
    expect(seatedTeam().map((t) => t.id)).toEqual(TEAM_IDS);
  });

  it("a project Ash takes off a team Mono stays off", () => {
    ensureBuiltInMonos();
    tieTeamToProjects(PROJECTS);
    removeMonoProject("frank", "/p/hivra");
    expect(tieTeamToProjects(PROJECTS)).toEqual([]);
    expect(findMono("frank")?.projects).not.toContain("/p/hivra");
  });

  it("each project's Leadership team gets the default team", () => {
    ensureBuiltInMonos();
    seatLeadershipTeams([...PROJECTS, GLOBAL_ASH]);
    for (const p of PROJECTS) expect(getChat(leadershipChatId(p.id))?.memberIds).toEqual(TEAM_IDS);
    expect(getChat(leadershipChatId("ash"))).toBeUndefined();
  });
});

describe("Critiquito, the add-on", () => {
  it("is offered for its real lane, ranked design critique, and starts unticked (never on a clean launch)", () => {
    expect(ADDON_OFFER).toEqual({ id: "critiquito", name: "Critiquito", what: "reviews how each screen looks and reads, and ranks the fixes" });
    ensureBuiltInMonos();
    expect(listMonos().some((m) => m.id === "critiquito")).toBe(false);
  });

  it("ticked, it joins with its soul and engine, works on the project and sits in its Leadership team", () => {
    ensureBuiltInMonos();
    expect(addTeamAddon("critiquito", [PROJECTS[3]])).toBe("critiquito");
    expect(findMono("critiquito")).toMatchObject({ name: "Critiquito", engine: "claude", projects: ["/p/monocode-hub"], instructions: TEAM_SOULS.critiquito });
    expect(getChat(leadershipChatId("hub"))?.memberIds).toContain("critiquito");
    expect(addTeamAddon("critiquito", [PROJECTS[1]])).toBe("critiquito"); // again: no second Critiquito
    expect(listMonos().filter((m) => m.id === "critiquito")).toHaveLength(1);
    expect(findMono("critiquito")?.projects).toEqual(["/p/monocode-hub", "/p/hivra"]);
    expect(seatedTeam().map((t) => t.id)).toContain("critiquito");
    expect(addTeamAddon("dr-eggbot")).toBeUndefined();
  });
});
