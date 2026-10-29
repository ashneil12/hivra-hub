// @vitest-environment happy-dom
// r63 (PM's G3/G4 on 0.16.3): after "kids maths" was renamed "maths game" the sidebar and menu read the new name, but the
// rail tile still read "kids": Ash OS renames the name and keeps the old short name. The tile now follows the rename.
import { beforeEach, expect, it } from "vitest";
import type { HubProject } from "./types";
import { applyProjectPrefs, railShortName } from "./projectPrefs";

const p = (name: string, shortName: string): HubProject => ({ id: name, name, shortName, iconShape: "folder", folder: null }) as HubProject;
beforeEach(() => localStorage.clear());

it("a short name that is no longer part of the name gives way to the name's first word", () => {
  expect(railShortName(p("maths game", "kids"))).toBe("maths");
  expect(applyProjectPrefs([p("maths game", "kids")])[0].shortName).toBe("maths");
});

it("a real short name stays: a word or part of the name, or its initials", () => {
  expect(railShortName(p("MonoCode Hub", "Hub"))).toBe("Hub");
  expect(railShortName(p("EXO game", "EXO"))).toBe("EXO");
  expect(railShortName(p("Hivra", "Hivra"))).toBe("Hivra");
  expect(railShortName(p("Bark Desk", "BD"))).toBe("BD");
  const same = p("Nibbii", "Nibbii");
  expect(applyProjectPrefs([same])[0]).toBe(same);
});
