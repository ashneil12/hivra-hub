// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { railMonos } from "./MonoRailSection";
import { ensureBuiltInMonos } from "../../features/hub/model/builtInMonos";
import { hubMonoRank } from "../../features/hub/model/hubData";

type M = { id: string; name: string; projects: string[] };
const FOLDERS = { EXO: "/Users/ash/Code/exo", Hivra: "/Users/ash/Code/hivra", Nibbii: "/Users/ash/Code/nibbii", Harness: "/Users/ash/Code/ash" };
const LEADS: M[] = [
  { id: "vg-game-lead", name: "EXO lead", projects: [FOLDERS.EXO] },
  { id: "hivra-lead", name: "Hivra lead", projects: [FOLDERS.Hivra] },
  { id: "nibbii-lead", name: "Nibbii lead", projects: [FOLDERS.Nibbii] },
  { id: "ash-lead", name: "Harness lead", projects: [FOLDERS.Harness] },
];
const EXPECTED = ["Chief of Staff", "Projects Manager", "frank", "Alfred", "EXO lead", "Hivra lead", "Nibbii lead", "Harness lead"];
const roster = () => JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as M[];

beforeEach(() => {
  localStorage.clear();
  // Ash's real data: the Leads already exist and fea2fbb's old one-time key is already set.
  localStorage.setItem("monocode:mono-roster", JSON.stringify(LEADS.map((l) => ({ ...l, mascot: "robot", color: "x" }))));
  localStorage.setItem("monocode:mono-team-added", "1");
});

describe("hub Monos section: one global list", () => {
  it("shows all 4 defaults first, then all 4 Leads", () => {
    ensureBuiltInMonos();
    expect(railMonos(roster(), undefined, hubMonoRank).map((m) => m.name)).toEqual(EXPECTED);
  });

  it("is exactly the same on EXO, Hivra, Nibbii and Harness", () => {
    ensureBuiltInMonos();
    for (const folder of Object.values(FOLDERS))
      expect(railMonos(roster(), folder, hubMonoRank).map((m) => m.name)).toEqual(EXPECTED);
  });
});
