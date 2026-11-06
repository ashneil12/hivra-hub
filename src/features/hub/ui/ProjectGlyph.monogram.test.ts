// @vitest-environment happy-dom
// WP-94: a project with no icon of its own shows two letters from its name on a coloured tile, instead of one grey letter
// or a generic folder. A project that has chosen a shape, an emoji or an image keeps it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectGlyph } from "./ProjectMenu";
import { setProjectIcon } from "../model/projectPrefs";
import { setHubDataSource } from "../model/hubData";
import { mockHubData } from "../model/mockData";
import type { HubProject } from "../model/types";
import { MONOGRAM_CLASSES, projectMonogram, projectMonogramColor } from "../model/projectMonogram";

const project = (id: string, name: string, iconShape: HubProject["iconShape"] = "folder"): HubProject => ({
  id,
  name,
  shortName: name,
  iconShape,
  folder: `/Users/example/Projects/${id}`,
});

const projects: HubProject[] = [];
let container: HTMLDivElement;
let root: Root;

function draw(one: HubProject) {
  act(() => root.render(createElement(ProjectGlyph, { project: one })));
  return container.querySelector("[data-project-glyph]")!;
}

beforeEach(() => {
  // The glyph reads prefs during render, which a plain test has to declare.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  projects.length = 0;
  setHubDataSource({
    ...mockHubData,
    listProjects: () => projects,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setHubDataSource(undefined);
});

describe("ProjectGlyph", () => {
  it("shows two letters from the name when no icon was chosen", () => {
    const nebula = project("nebula", "Nebula");
    projects.push(nebula);
    const glyph = draw(nebula);

    expect(glyph.getAttribute("data-project-glyph")).toBe("monogram");
    expect(glyph.textContent).toBe("NA");
    expect(glyph.getAttribute("data-project-monogram")).toBe("NA");
    // The colour is the name's own: the same name always gets the same colour.
    expect(glyph.className).toContain(MONOGRAM_CLASSES[projectMonogramColor("Nebula")]);
  });

  it("treats the placeholder folder shape as no icon of its own", () => {
    // Every project gets "folder" when no shape was chosen (toShape in projectShapes.ts), so the tile must not say
    // "generic folder" for all of them: it draws the name's letters instead.
    const forge = project("forge", "M7 Forge", "folder");
    projects.push(forge);
    const glyph = draw(forge);
    expect(glyph.getAttribute("data-project-glyph")).toBe("monogram");
    expect(glyph.textContent).toBe("M7");
  });

  it("gives two projects different colours from their names", () => {
    const silver = project("silver", "Silver Orchard");
    const forge = project("forge", "M7 Forge");
    projects.push(silver, forge);
    const first = draw(silver).className;
    const second = draw(forge).className;
    expect(projectMonogram("Silver Orchard")).toBe("SO");
    expect(projectMonogram("M7 Forge")).toBe("M7");
    expect(MONOGRAM_CLASSES[projectMonogramColor("Silver Orchard")]).not.toBe(
      MONOGRAM_CLASSES[projectMonogramColor("M7 Forge")],
    );
    expect(first).not.toBe(second);
  });

  it("keeps a shape the project chose", () => {
    const exo = project("exo", "EXO game", "gamepad");
    projects.push(exo);
    const glyph = draw(exo);
    expect(glyph.getAttribute("data-project-glyph")).toBe("shape");
    expect(glyph.getAttribute("data-project-shape")).toBe("gamepad");
  });

  it("keeps an emoji or an image the project was given on this Mac", () => {
    const hivra = project("hivra", "Hivra", "folder");
    projects.push(hivra);
    act(() => setProjectIcon("hivra", { kind: "emoji", emoji: "🚀" }));
    expect(draw(hivra).getAttribute("data-project-glyph")).toBe("emoji");
    act(() => setProjectIcon("hivra", { kind: "image", src: "asset://localhost/hivra.png", path: "/x" }));
    expect(draw(hivra).getAttribute("data-project-glyph")).toBe("image");
    act(() => setProjectIcon("hivra", undefined));
    expect(draw(hivra).getAttribute("data-project-glyph")).toBe("monogram");
  });

  it("draws a name with nothing in it without crashing", () => {
    const blank = project("blank", "   ");
    projects.push(blank);
    const glyph = draw(blank);
    expect(glyph.getAttribute("data-project-glyph")).toBe("monogram");
    expect(glyph.textContent).toBe("PR");
  });
});
