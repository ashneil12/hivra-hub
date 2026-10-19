import { describe, expect, it } from "vitest";
import { distinctShapes, stripProjects } from "./hubProjects";
import { calmSummary } from "./hubData";
import { mapProject } from "./hubStore";
import { PROJECT_SHAPES, toShape } from "./projectShapes";
import type { HubProject } from "./types";

const p = (id: string, extra: Partial<HubProject> = {}): HubProject => ({ id, name: id, shortName: id, iconShape: "folder", folder: null, ...extra });

describe("the strip's projects", () => {
  it("are exactly what Ash OS lists, in its order, without parked ones (a new project joins the end)", () => {
    const live = [p("vg-game", { iconShape: "gamepad" }), p("hivra", { iconShape: "sparkles" }), p("nibbii", { iconShape: "palette" }), p("hub", { iconShape: "gauge", name: "MonoCode Hub", shortName: "Hub" }), p("moonrise", { iconShape: "rocket" }), p("old", { parked: true })];
    const out = stripProjects(live);
    expect(out.map((x) => x.id)).toEqual(["vg-game", "hivra", "nibbii", "hub", "moonrise"]);
    expect(out.map((x) => x.iconShape)).toEqual(["gamepad", "sparkles", "palette", "gauge", "rocket"]);
    expect(stripProjects([...live].reverse()).map((x) => x.id)).toEqual(["moonrise", "hub", "nibbii", "hivra", "vg-game"]);
  });

  it("never show the global `ash` memory as a project, even when Ash OS sends it in its old strip slot", () => {
    const oldStrip = [p("vg-game"), p("hivra"), p("nibbii"), p("ash", { name: "Harness", shortName: "Harness", iconShape: "gauge" })];
    expect(stripProjects(oldStrip).map((x) => x.id)).toEqual(["vg-game", "hivra", "nibbii"]);
  });

  it("keep Ash's own shapes even when two projects share one", () => {
    const theirs = [p("vg-game", { iconShape: "gauge" }), p("hivra", { iconShape: "gauge" }), p("nibbii", { iconShape: "folder" })];
    expect(distinctShapes(theirs).map((x) => x.iconShape)).toEqual(["gauge", "gauge", "folder"]);
  });

  it("an older service that says 'folder' for every project gets stand-in shapes, the same every time, never a ghost", () => {
    const all = [p("vg-game"), p("hivra"), p("nibbii"), p("hub"), p("side-thing")];
    const a = distinctShapes(all);
    expect(a.slice(0, 4).map((x) => x.iconShape)).toEqual(["gamepad", "sparkles", "palette", "gauge"]);
    expect(distinctShapes([...all]).map((x) => x.iconShape)).toEqual(a.map((x) => x.iconShape));
    expect(new Set(a.map((x) => x.iconShape)).size).toBe(5);
  });
});

describe("project shapes", () => {
  it("are Ash OS's fourteen, with no ghost; a stored ghost reads as the gamepad", () => {
    expect(PROJECT_SHAPES).toHaveLength(14);
    expect(PROJECT_SHAPES).not.toContain("ghost" as never);
    expect(toShape("ghost")).toBe("gamepad");
    expect(toShape("rocket")).toBe("rocket");
    expect(toShape("unicorn")).toBe("folder");
    expect(mapProject({ id: "vg-game", name: "EXO", iconShape: "ghost" })?.iconShape).toBe("gamepad");
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
