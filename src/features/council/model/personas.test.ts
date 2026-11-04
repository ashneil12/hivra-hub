import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { bundledPersonas, combinePersonas, parsePersona } from "./personas";

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

const NESTED = `<!--
Copyright (c) 2026 nyk
-->
---
name: council-ada
description: "Council member. Formal systems."
model: sonnet
tools: ["Read", "Grep"]
council:
  figure: Ada Lovelace
  reasoning_method: formal-stepwise-verification
---

## Identity

You are Ada Lovelace.
`;

it("reads a licence comment and nested frontmatter, and skips a line that is not a field", () => {
  const persona = parsePersona("council-ada", NESTED.replace(/\n/g, "\r\n"));
  expect(persona).toMatchObject({
    id: "council-ada",
    description: "Council member. Formal systems.",
    model: "sonnet",
    method: "formal-stepwise-verification",
  });
  expect(persona?.body).toContain("Ada Lovelace");
  expect(parsePersona("council-ada", NESTED.replace("description:", "nope:"))).toBeNull();
});

it("ships the 18 vendored personas", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../personas");
  const files = readdirSync(dir).filter((name) => name.startsWith("council-") && name.endsWith(".md")).sort();
  expect(files).toHaveLength(18);
  for (const name of files) {
    const id = name.replace(/\.md$/, "");
    const persona = parsePersona(id, readFileSync(join(dir, name), "utf8"));
    expect(persona?.body.length).toBeGreaterThan(0);
    expect(persona?.description.length).toBeGreaterThan(0);
  }
  const bundled = bundledPersonas();
  expect(bundled.map((persona) => persona.id)).toEqual(files.map((name) => name.replace(/\.md$/, "")));
  expect(bundled.find((persona) => persona.id === "council-ada")?.body).toContain("Ada Lovelace");
  expect(bundled.find((persona) => persona.id === "council-ada")?.method).toBe("formal-stepwise-verification");
});
