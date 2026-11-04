import { expect, it } from "vitest";
import { combinePersonas, parsePersona } from "./personas";

const file = (id: string, extra = "", body = "Doubt the easy answer.") => `---\nname: ${id}\ndescription: A sceptic.\n${extra}---\n\n${body}\n`;

it("reads a persona file and skips one that is the wrong shape", () => {
  const good = parsePersona("skeptic", file("skeptic", "weight: 2\nmodel: opus\n"));
  expect(good).toMatchObject({ id: "skeptic", description: "A sceptic.", weight: 2, model: "opus", body: "Doubt the easy answer." });

  expect(parsePersona("skeptic", file("other"))).toBeNull();
  expect(parsePersona("skeptic", file("skeptic", "", "  "))).toBeNull();
  expect(parsePersona("skeptic", "no frontmatter")).toBeNull();
  expect(parsePersona("../skeptic", file("../skeptic"))).toBeNull();
  expect(parsePersona("skeptic", file("skeptic").replace(/\n/g, "\r\n"))?.body).toBe("Doubt the easy answer.");

  const heavy = parsePersona("skeptic", file("skeptic", "weight: 40\n"));
  expect(heavy?.weight).toBeUndefined();
  const bad = parsePersona("skeptic", file("skeptic", "weight: many\n"));
  expect(bad?.weight).toBeUndefined();
  expect(bad?.description).toBe("A sceptic.");
});

it("keeps the first persona of an id and skips a plugin file that does not parse", () => {
  const bundled = parsePersona("skeptic", file("skeptic", "weight: 1\n"))!;
  const merged = combinePersonas(
    [bundled],
    [
      { id: "skeptic", markdown: file("skeptic", "weight: 3\n") },
      { id: "broken", markdown: "hello" },
      { id: "builder", markdown: file("builder") },
    ],
  );
  expect(merged.map((p) => p.id)).toEqual(["skeptic", "builder"]);
  expect(merged[0].weight).toBe(1);
});
