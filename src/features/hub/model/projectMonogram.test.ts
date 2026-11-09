// WP-94: a project with no icon of its own gets two letters from its name and a colour that never changes for that name.
// The letters follow T3 Code's projectMonogram (MIT, Copyright (c) 2026 T3 Tools Inc.); the colour, its projectColor.
import { describe, expect, it } from "vitest";
import {
  projectMonogram,
  projectMonogramColor,
  PROJECT_MONOGRAM_COLORS,
} from "./projectMonogram";

describe("projectMonogram", () => {
  it("takes the first letter and the last letter of a one-word name", () => {
    expect(projectMonogram("Nebula")).toBe("NA");
    expect(projectMonogram("EXO")).toBe("EO");
  });

  it("takes the first letter of each of the first and last words", () => {
    expect(projectMonogram("Silver Orchard")).toBe("SO");
    expect(projectMonogram("MonoCode Hub")).toBe("MH");
    expect(projectMonogram("Ash OS work notes")).toBe("AN");
  });

  it("prefers a digit inside the first word, so a code-like name keeps it", () => {
    expect(projectMonogram("M7 Forge")).toBe("M7");
    expect(projectMonogram("Studio 54")).toBe("S5");
  });

  it("is grapheme-aware, so a decorated letter is one letter", () => {
    // A combining accent stays with its letter rather than becoming a separate "letter". NFKC folds the decomposed
    // form onto the composed one, so one person's accent and another's produce the same tile.
    expect(projectMonogram("Émile")).toBe("ÉE");
    expect(projectMonogram("Émile".normalize("NFD"))).toBe("ÉE");
    // Words are letters and digits (as in T3), so a bare emoji is not a word and the next real word names the tile. A
    // keycap is a digit, so it counts.
    expect(projectMonogram("🌱 Garden")).toBe("GN");
    expect(projectMonogram("1️⃣ Key")).toBe("1K");
    // An emoji beside a word is not part of it (T3's word match is letters and digits), so the tile is the word's own
    // letters.
    expect(projectMonogram("ship🚢")).toBe("SP");
  });

  it("ignores punctuation and stray spacing", () => {
    expect(projectMonogram("  silver   orchard  ")).toBe("SO");
    expect(projectMonogram("hivra (the hub)")).toBe("HH");
    expect(projectMonogram("Nibbii!")).toBe("NI");
  });

  it("falls back when there is nothing to draw letters from", () => {
    expect(projectMonogram("")).toBe("PR");
    expect(projectMonogram("   ")).toBe("PR");
    expect(projectMonogram("---")).toBe("PR");
  });

  it("keeps a one-letter name a single letter", () => {
    expect(projectMonogram("X")).toBe("X");
  });

  it("normalises a compatibility character before drawing it", () => {
    // NFKC turns the full-width letters into ordinary ones.
    expect(projectMonogram("ＮＥＢＵＬＡ")).toBe("NA");
  });
});

describe("projectMonogramColor", () => {
  it("always gives the same name the same colour", () => {
    expect(projectMonogramColor("Silver Orchard")).toBe(projectMonogramColor("Silver Orchard"));
    // Case and spacing are the person's typing, not a different project.
    expect(projectMonogramColor("silver orchard")).toBe(projectMonogramColor("Silver Orchard"));
    expect(projectMonogramColor("  Nebula ")).toBe(projectMonogramColor("Nebula"));
  });

  it("draws every colour from the named palette", () => {
    const names = ["Nebula", "Silver Orchard", "M7 Forge", "Hivra", "EXO", "Nibbii", "Hub", "Tally", "Raven", "Crest"];
    for (const name of names) expect(PROJECT_MONOGRAM_COLORS).toContain(projectMonogramColor(name));
  });

  it("spreads different names across the palette", () => {
    const names = ["Nebula", "Silver Orchard", "M7 Forge", "Hivra", "EXO", "Nibbii", "Hub", "Tally", "Raven", "Crest"];
    const used = new Set(names.map(projectMonogramColor));
    expect(used.size).toBeGreaterThan(3);
  });

  it("still gives an unnamed project a colour", () => {
    expect(PROJECT_MONOGRAM_COLORS).toContain(projectMonogramColor(""));
  });
});
