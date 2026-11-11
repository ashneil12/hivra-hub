// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { joinableMonos, railMonos } from "./MonoRailSection";
import { hubMonoRank } from "../../features/hub/model/hubData";

type M = { id: string; name: string; projects: string[] };
const FOLDERS = { EXO: "/Users/ash/Code/exo", Hivra: "/Users/ash/Code/hivra", Nibbii: "/Users/ash/Code/nibbii", Harness: "/Users/ash/Code/ash" };
const LEADS: M[] = [
  { id: "vg-game-lead", name: "EXO lead", projects: [FOLDERS.EXO] },
  { id: "hivra-lead", name: "Hivra lead", projects: [FOLDERS.Hivra] },
  { id: "nibbii-lead", name: "Nibbii lead", projects: [FOLDERS.Nibbii] },
  { id: "ash-lead", name: "Harness lead", projects: [FOLDERS.Harness] },
];
const ORDINARY = [
  { id: "ada", name: "Ada" },
  { id: "bo", name: "Bo" },
  { id: "ed", name: "Ed" },
  { id: "cam", name: "Cam" },
] as const;
const roster = () => JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as M[];

beforeEach(() => {
  localStorage.clear();
  // Ash's real data: the Leads already exist and fea2fbb's old one-time key is already set.
  localStorage.setItem("monocode:mono-roster", JSON.stringify(LEADS.map((l) => ({ ...l, mascot: "robot", color: "x" }))));
  localStorage.setItem("monocode:mono-team-added", "1");
});

describe("hub Monos section: one global list", () => {
  it("does not insert a default team in front of Monos already on the roster", async () => {
    vi.resetModules();
    const { ensureBuiltInMonos, DEFAULT_TEAM_IDS } = await import("../../features/hub/model/builtInMonos");
    expect(DEFAULT_TEAM_IDS).toEqual([]);
    expect(ensureBuiltInMonos()).toBe(0);
    expect(railMonos(roster(), undefined, hubMonoRank).map((m) => m.name)).toEqual(LEADS.map((m) => m.name));
  });

  it("shows only explicitly assigned Monos on each project while keeping everyone available on Today", async () => {
    vi.resetModules();
    const { addMono } = await import("../../features/monos/model/mono");
    for (const { id, name } of ORDINARY) addMono({ id, name, mascot: "robot", color: "gray", projects: [] });
    expect(railMonos(roster(), undefined, hubMonoRank).map((m) => m.name)).toEqual([...LEADS.map((m) => m.name), ...ORDINARY.map((m) => m.name)]);
    for (const folder of Object.values(FOLDERS))
      expect(railMonos(roster(), folder, hubMonoRank).map((m) => m.name)).toEqual(LEADS.filter((m) => m.projects.includes(folder)).map((m) => m.name));
  });

  it("offers a project the first mates already made, but not its own, the Chief of Staff or another project's Lead", () => {
    const list: M[] = [
      ...LEADS,
      { id: "chief", name: "Chief of Staff", projects: [] },
      { id: "iris", name: "Iris", projects: [FOLDERS.Hivra] },
      { id: "milo", name: "Milo", projects: [FOLDERS.Nibbii] },
      { id: "ada", name: "Ada", projects: [] },
    ];
    expect(joinableMonos(list, FOLDERS.Hivra, "chief").map((m) => m.name)).toEqual(["Milo", "Ada"]);
    expect(joinableMonos(list, FOLDERS.Nibbii, "chief").map((m) => m.name)).toEqual(["Iris", "Ada"]);
  });
});
