import { describe, expect, it } from "vitest";
import { distinctShapes, stripProjects } from "./hubProjects";
import { calmSummary } from "./hubData";
import type { HubProject } from "./types";

const p = (id: string, extra: Partial<HubProject> = {}): HubProject => ({ id, name: id, shortName: id, iconShape: "folder", folder: null, ...extra });
// What the live service returned on 15 Oct: every project "folder", parked ones included, registry order.
const LIVE = ["ash", "atlas", "bible", "clearweb", "hivra", "ideas", "img2threejs", "nibbii", "trading-sim", "vg-game"].map((id) =>
  p(id, { ash: { name: "Harness & how I work", shortName: "Harness" }, "vg-game": { name: "EXO", shortName: "EXO" }, hivra: { name: "Hivra", shortName: "Hivra" }, nibbii: { name: "Nibbii", shortName: "Nibbii" } }[id] ?? {}),
);

describe("the strip's projects", () => {
  it("are Ash's four, in his order: EXO, Hivra, Nibbii, Harness", () => {
    const out = stripProjects(LIVE);
    expect(out.map((x) => x.id)).toEqual(["vg-game", "hivra", "nibbii", "ash"]);
    expect(out.map((x) => x.shortName)).toEqual(["EXO", "Hivra", "Nibbii", "Harness"]);
    expect(out.find((x) => x.id === "ash")?.name).toBe("Harness");
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
    expect(stripProjects([p("hivra"), p("ash")]).map((x) => x.id)).toEqual(["hivra", "ash"]);
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
