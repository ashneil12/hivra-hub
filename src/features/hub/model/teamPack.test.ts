// @vitest-environment happy-dom
// G5, Ash 14 Oct: "wouldn't ship with our stuff pre loaded by default ... as long as its easy to ship a clean app".
// Ash 21 Oct: the default team is the leadership team minus personal memories. A fresh install gets the same five
// Monos with nothing of Ash's in them and no pre-load (his team arrives by importing his export); an install that
// already has his team (his Mac) is left exactly as it is.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addMono, listMonos } from "../../monos/model/mono";
import { defaultSoul } from "../../monos/model/monoFiles";
import { ensureBuiltInMonos } from "./builtInMonos";
import { seedTeamFiles } from "./hubTeam";
import { soulTemplates } from "./soulRefresh";
import { teamPack } from "./teamPack";
import { PLAIN_SOULS, TEAM_SOULS } from "./teamSouls";

const TEAM_IDS = ["chief-of-staff", "projects-manager", "frank", "alfred"];
const SHIPPED_IDS = [...TEAM_IDS, "critiquito"];
/** Ash's name, projects, product, accounts and pronouns: none of it ships (Ash 21 Oct). */
const ASH_STUFF = /\bAsh\b|Hivra|Nibbii|EXO|Operator OS|MonoCode|Monocode|Grok|UK lawyer|ash-asks|\b(he|him|his|himself)\b/i;

function files(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const read = vi.fn(async (id: string, path: string) => ({ text: store.get(`${id}/${path}`) ?? null, hash: store.get(`${id}/${path}`) ?? "" }));
  const write = vi.fn(async (id: string, path: string, text: string) => void store.set(`${id}/${path}`, text));
  return { store, read, write };
}
const storage = () => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));

beforeEach(() => localStorage.clear());

describe("a fresh install", () => {
  it("starts with the default team, names and personalities kept, minus anything personal to Ash", async () => {
    localStorage.setItem("monocode:mono-roster", "[]"); // an empty roster is no data yet
    ensureBuiltInMonos();
    expect(teamPack()).toBe("plain");
    expect(listMonos().map((m) => m.id)).toEqual(TEAM_IDS); // Critiquito is an add-on, offered unticked (Ash 14 Oct)
    expect(listMonos().map((m) => m.name)).toEqual(["Chief of Staff", "Projects Manager", "frank", "Alfred"]);
    for (const m of listMonos()) expect(m.instructions, m.id).toBe(PLAIN_SOULS[m.id]);
    // The same people: each shipped soul keeps its role, who it is and its skills.
    for (const id of SHIPPED_IDS) {
      const heads = (t: string) => t.match(/^## .*$/gm)?.length;
      expect(heads(PLAIN_SOULS[id]), id).toBe(heads(TEAM_SOULS[id]));
      expect(PLAIN_SOULS[id].split("## Skills")[1], id).toBe(TEAM_SOULS[id].split("## Skills")[1]);
    }
    const f = files();
    expect(await seedTeamFiles(f.read, f.write)).toEqual(TEAM_IDS);
    for (const id of TEAM_IDS) {
      expect(f.store.get(`${id}/SOUL.md`), id).toBe(PLAIN_SOULS[id]);
      expect(f.store.has(`${id}/MEMORY.md`), id).toBe(false);
    }
    for (const soul of Object.values(PLAIN_SOULS)) expect(soul).not.toMatch(ASH_STUFF);
    for (const t of soulTemplates()) expect(t.template, t.monoId).toBe(PLAIN_SOULS[t.monoId]);
    // Still plain on the next launch, once its own team exists.
    ensureBuiltInMonos();
    expect(teamPack()).toBe("plain");
  });
});

describe("an install that already has Ash's team", () => {
  it("is left exactly as it is: same souls, memory and roster, nothing written, no pack recorded", async () => {
    for (const id of TEAM_IDS) addMono({ id, name: findName(id), mascot: "robot", color: "x", projects: ["/p/hivra"], engine: "claude" });
    localStorage.setItem("monocode:mono-team-seeded", "1");
    localStorage.setItem("monocode:mono-team-added", "1");
    localStorage.setItem("monocode:hub-team-souls-seeded", JSON.stringify(TEAM_IDS));
    const own = Object.fromEntries(TEAM_IDS.flatMap((id) => [[`${id}/SOUL.md`, TEAM_SOULS[id]], [`${id}/MEMORY.md`, `- 2026-10-19 · ${id} knows Hivra ships Friday`]]));
    own["frank/SOUL.md"] = "# Soul\n\nAsh's own frank.\n";
    const f = files(own);
    const before = storage();
    const roster = JSON.stringify(listMonos());

    expect(ensureBuiltInMonos()).toBe(0); // Critiquito stays the add-on it is on his install
    expect(listMonos().some((m) => m.id === "critiquito")).toBe(false);
    expect(await seedTeamFiles(f.read, f.write)).toEqual([]);
    expect(teamPack()).toBe("ash");

    expect(f.write).not.toHaveBeenCalled();
    expect(Object.fromEntries(f.store)).toEqual(own);
    expect(storage()).toEqual(before);
    expect(JSON.stringify(listMonos())).toBe(roster);
    for (const t of soulTemplates()) expect(t.template, t.monoId).toBe(defaultSoul(TEAM_SOULS[t.monoId]));
  });
});

describe("a WebKit reset on an existing install", () => {
  it("is still Ash's: the roster back from the Monos' home is enough, and nothing is recorded", () => {
    addMono({ id: "chief-of-staff", name: "Chief of Staff", mascot: "robot", color: "x", projects: [] });
    expect(teamPack()).toBe("ash");
    expect(localStorage.getItem("monocode:hub-team-pack")).toBeNull();
  });
});

function findName(id: string): string {
  return { "chief-of-staff": "Chief of Staff", "projects-manager": "Projects Manager", frank: "frank", alfred: "Alfred" }[id] ?? id;
}
