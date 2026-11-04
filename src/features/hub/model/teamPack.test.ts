// @vitest-environment happy-dom
// A fresh install starts with no team. A pack is still plain, ash or imported: existing data reads as ash and is left
// alone, a fresh install is recorded as plain, and an imported pack stays imported.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addMono, listMonos } from "../../monos/model/mono";
import { ensureBuiltInMonos } from "./builtInMonos";
import { seedTeamFiles } from "./hubTeam";
import { soulTemplates } from "./soulRefresh";
import { setTeamPack, startingMemory, teamPack, teamSouls } from "./teamPack";
import { PLAIN_SOULS, TEAM_SOULS } from "./teamSouls";

function files(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const read = vi.fn(async (id: string, path: string) => ({ text: store.get(`${id}/${path}`) ?? null, hash: store.get(`${id}/${path}`) ?? "" }));
  const write = vi.fn(async (id: string, path: string, text: string) => void store.set(`${id}/${path}`, text));
  return { store, read, write };
}
const storage = () => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));

beforeEach(() => localStorage.clear());

describe("a fresh install", () => {
  it("starts with no team and no souls, and stays plain once that is recorded", async () => {
    localStorage.setItem("monocode:mono-roster", "[]");
    expect(ensureBuiltInMonos()).toBe(0);
    expect(teamPack()).toBe("plain");
    expect(localStorage.getItem("monocode:hub-team-pack")).toBe("plain");
    expect(listMonos()).toEqual([]);
    expect(PLAIN_SOULS).toEqual({});
    expect(TEAM_SOULS).toEqual({});
    expect(teamSouls()).toEqual({});
    const f = files();
    expect(await seedTeamFiles(f.read, f.write)).toEqual([]);
    expect(f.write).not.toHaveBeenCalled();
    expect(soulTemplates()).toEqual([]);
    ensureBuiltInMonos();
    expect(teamPack()).toBe("plain");
    expect(listMonos()).toEqual([]);
  });
});

describe("an install that already has data", () => {
  it("reads as ash and is left exactly as it is: nothing written, no pack recorded", async () => {
    addMono({ id: "mina", name: "Mina", mascot: "robot", color: "x", projects: ["/p/hivra"], engine: "claude" });
    const own = { "mina/SOUL.md": "# Soul\n\nMina's own words.\n" };
    const f = files(own);
    const before = storage();
    const roster = JSON.stringify(listMonos());
    expect(ensureBuiltInMonos()).toBe(0);
    expect(await seedTeamFiles(f.read, f.write)).toEqual([]);
    expect(teamPack()).toBe("ash");
    expect(f.write).not.toHaveBeenCalled();
    expect(Object.fromEntries(f.store)).toEqual(own);
    expect(storage()).toEqual(before);
    expect(localStorage.getItem("monocode:hub-team-pack")).toBeNull();
    expect(JSON.stringify(listMonos())).toBe(roster);
    expect(soulTemplates().map((t) => t.monoId)).not.toContain("mina");
  });
});

describe("a WebKit reset on an existing install", () => {
  it("is still ash: any roster entry is enough, and nothing is recorded", () => {
    addMono({ id: "mina", name: "Mina", mascot: "robot", color: "x", projects: [] });
    expect(teamPack()).toBe("ash");
    expect(localStorage.getItem("monocode:hub-team-pack")).toBeNull();
  });
});

describe("an imported pack", () => {
  it("stays imported, with no souls and no seeded memory, even when a roster exists", () => {
    addMono({ id: "mina", name: "Mina", mascot: "robot", color: "x", projects: ["/p/shop"] });
    setTeamPack("imported");
    expect(teamPack()).toBe("imported");
    expect(teamSouls()).toEqual({});
    expect(startingMemory("mina")).toBe("");
    expect(localStorage.getItem("monocode:hub-team-pack")).toBe("imported");
  });
});
