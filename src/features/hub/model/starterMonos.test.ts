// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { addMono, findMono, listMonos } from "../../monos/model/mono";
import { ensureBuiltInMonos } from "./builtInMonos";
import { addStarterMono, starterOffers } from "./starterMonos";

beforeEach(() => localStorage.clear());

describe("starter monos", () => {
  it("loads the bundled templates, and none of them is a special id", () => {
    const offers = starterOffers();
    expect(offers.map((offer) => offer.name)).toEqual([
      "Chief of Staff",
      "Design review",
      "Planner",
      "Record keeper",
      "Team steward",
    ]);
    for (const offer of offers) {
      expect(offer.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(offer.soul.startsWith("# Soul\n")).toBe(true);
      expect(offer.soul).toContain("## Role");
      expect(offer.soul).toContain("## Skills");
      expect(offer.soul).not.toMatch(/\bAsh\b|EXO|Grok Bot/);
    }
  });

  it("adding one makes an ordinary mono, and a second add is another mono", () => {
    const offer = starterOffers().find((item) => item.name === "Chief of Staff");
    expect(offer).toBeDefined();
    const first = addStarterMono(offer!.id, ["/work/demo"]);
    const second = addStarterMono(offer!.id);
    expect(first?.id).toBeTruthy();
    expect(first?.id).not.toBe(offer!.id);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.id).not.toBe(offer!.id);
    expect(first).toMatchObject({ name: "Chief of Staff", role: offer!.role, instructions: offer!.soul, projects: ["/work/demo"] });
    expect(listMonos()).toHaveLength(2);
  });

  it("an unknown template adds nothing, including an empty id", () => {
    expect(addStarterMono("")).toBeUndefined();
    expect(addStarterMono("not-a-template")).toBeUndefined();
    expect(listMonos()).toEqual([]);
  });

  it("a launch does not add them, and an edited soul already on the roster stays", () => {
    const edited = "# Soul\n\n## Role\nMine, rewritten.\n";
    addMono({ id: "kept-mono", name: "Kept", mascot: "robot", color: "hsl(210 8% 58%)", projects: [], instructions: edited });
    expect(ensureBuiltInMonos()).toBe(0);
    expect(listMonos().map((mono) => mono.id)).toEqual(["kept-mono"]);
    expect(findMono("kept-mono")?.instructions).toBe(edited);
    addStarterMono(starterOffers()[0].id);
    expect(findMono("kept-mono")?.instructions).toBe(edited);
  });

  it("only the coordinator starts able to read every project", () => {
    const offers = starterOffers();
    const coordinator = offers.find((item) => item.name === "Chief of Staff");
    expect(coordinator?.everyProject).toBe(true);
    expect(coordinator?.soul).toContain("\nEvery project: read\n");
    expect(offers.filter((item) => item.everyProject).map((item) => item.id)).toEqual([coordinator?.id]);
    const added = addStarterMono(coordinator!.id);
    expect(added?.id).not.toBe(coordinator?.id);
    expect(added?.everyProject).toBe(true);
    const other = offers.find((item) => item.name === "Planner");
    expect(other?.everyProject).toBeUndefined();
    expect(addStarterMono(other!.id)?.everyProject).toBeUndefined();
  });
});
