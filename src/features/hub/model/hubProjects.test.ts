import { describe, expect, it } from "vitest";
import { distinctShapes, stripProjects } from "./hubProjects";
import { calmSummary } from "./hubData";
import type { HubProject } from "./types";

const p = (id: string, extra: Partial<HubProject> = {}): HubProject => ({ id, name: id, shortName: id, iconShape: "folder", folder: null, ...extra });
// The live registry's projects (every one "folder", parked ones included, registry order). Since 19 Oct the harness
// work is the project `hub`; `ash` is Ash's global memory ("How Ash works"), which Ash OS may still send.
const LIVE = ["ash", "atlas", "bible", "clearweb", "hivra", "hub", "ideas", "img2threejs", "nibbii", "trading-sim", "vg-game"].map((id) =>
  p(id, { ash: { name: "How Ash works", shortName: "Harness" }, hub: { name: "MonoCode Hub", shortName: "MonoCode", folder: "/Users/ash/Projects/monocode-hub" }, "vg-game": { name: "EXO", shortName: "EXO" }, hivra: { name: "Hivra", shortName: "Hivra" }, nibbii: { name: "Nibbii", shortName: "Nibbii" } }[id] ?? {}),
);

describe("the strip's projects", () => {
  it("are Ash's four, in his order: EXO, Hivra, Nibbii, MonoCode Hub", () => {
    const out = stripProjects(LIVE);
    expect(out.map((x) => x.id)).toEqual(["vg-game", "hivra", "nibbii", "hub"]);
    expect(out.map((x) => x.shortName)).toEqual(["EXO", "Hivra", "Nibbii", "Hub"]);
    expect(out.find((x) => x.id === "hub")).toMatchObject({ name: "MonoCode Hub", folder: "/Users/ash/Projects/monocode-hub" });
  });

  it("never show the global `ash` memory as a project, even when Ash OS sends it in its old strip slot", () => {
    const oldStrip = [p("vg-game"), p("hivra"), p("nibbii"), p("ash", { name: "Harness", shortName: "Harness", iconShape: "gauge" })];
    expect(stripProjects(oldStrip).map((x) => x.id)).toEqual(["vg-game", "hivra", "nibbii"]);
    expect(stripProjects(LIVE).some((x) => x.id === "ash")).toBe(false);
  });

  it("are told apart by shape even when Ash OS says 'folder' for all of them, the same shape every time", () => {
    const out = stripProjects(LIVE);
    expect(new Set(out.map((x) => x.iconShape)).size).toBe(4);
    expect(out.map((x) => x.iconShape)).toEqual(["ghost", "sparkles", "palette", "gauge"]);
    expect(stripProjects([...LIVE].reverse()).map((x) => x.iconShape)).toEqual(["ghost", "sparkles", "palette", "gauge"]);
  });

  it("use Ash OS's own shapes once they tell the projects apart", () => {
    const theirs = [p("vg-game", { iconShape: "gauge" }), p("hivra", { iconShape: "ghost" }), p("nibbii", { iconShape: "folder" }), p("ash", { iconShape: "palette" })];
    expect(distinctShapes(theirs).map((x) => x.iconShape)).toEqual(["gauge", "ghost", "folder", "palette"]);
  });

  it("give an unknown project a free shape from its id, deterministically", () => {
    const a = distinctShapes([p("vg-game"), p("side-thing")]);
    const b = distinctShapes([p("vg-game"), p("side-thing")]);
    expect(a[1].iconShape).toBe(b[1].iconShape);
    expect(a[1].iconShape).not.toBe("ghost");
  });

  it("leave out a project Ash OS doesn't list", () => {
    expect(stripProjects([p("hivra"), p("hub")]).map((x) => x.id)).toEqual(["hivra", "hub"]);
  });
});

describe("the Since paragraph", () => {
  it("drops lists of raw titles in brackets, keeps short asides", () => {
    const raw =
      "311 things got finished (Be ready to discuss and decide the best approach to the build system with Ash, since he is, Restyle bag, codex, map overlay); 221 decisions were saved to memory. Nibbii (quiet) has 2 waiting on you.";
    expect(calmSummary(raw)).toBe("311 things got finished; 221 decisions were saved to memory. Nibbii (quiet) has 2 waiting on you.");
  });
  it("leaves plain text alone", () => {
    expect(calmSummary("While you were away, the game got a big push.")).toBe("While you were away, the game got a big push.");
  });
});
