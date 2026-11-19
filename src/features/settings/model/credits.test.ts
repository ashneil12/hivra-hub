// WP-08: README, NOTICE, SOURCES.md and the Credits view must list the same sources. Edit docs/hivra/credits.json and
// the docs together; this test names whichever one drifted.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CREDITED_COMPONENTS, INSPIRATIONS, type CreditedComponent } from "./credits";
import { CreditsList } from "../ui/CreditsList";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** A component whose code is not in the tree yet; its NOTICE entry lands in the PR that copies it. */
const plannedAs = (component: CreditedComponent) =>
  /^Planned for (WP-\d+), code not copied yet:/.exec(component.how)?.[1];

/** The rows of SOURCES.md's "The sources" table: name, link and licence. */
function sourcesTable() {
  const text = read("docs/hivra/SOURCES.md");
  const table = text.slice(text.indexOf("## The sources"), text.indexOf("## Vision to packages"));
  return [...table.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\)[^|]*\| ([^|]+?) \|/gm)].map((m) => ({
    name: m[1],
    url: m[2],
    licence: m[3],
  }));
}

describe("credits", () => {
  it("matches every source in SOURCES.md, in order, with its link and licence", () => {
    const table = sourcesTable();
    expect(table.length).toBeGreaterThan(0);
    expect(INSPIRATIONS.map(({ name, url, licence }) => ({ name, url, licence }))).toEqual(table);
  });

  it("is the README's Inspirations list, line for line", () => {
    const readme = read("README.md");
    const section = readme.slice(readme.indexOf("## Inspirations"), readme.indexOf("## Status"));
    const lines = section.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual(INSPIRATIONS.map((s) => `- [${s.name}](${s.url}): ${s.gave}.`));
  });

  it("gives every component already in the tree a NOTICE entry with its source, licence and copyright", () => {
    const notice = read("NOTICE");
    const hivra = notice.slice(0, notice.indexOf("\nMonoCode\n========"));
    expect(hivra.startsWith("Hivra\n=====")).toBe(true);
    const entries = [...hivra.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    const shipped = CREDITED_COMPONENTS.filter((c) => !plannedAs(c));
    expect(entries).toEqual(shipped.map((c) => c.name));
    for (const c of shipped) {
      const entry = hivra.slice(hivra.indexOf(`- ${c.name}\n`)).split("\n\n")[0];
      expect(entry).toContain(`Source: ${c.url}`);
      expect(entry).toContain(`License: ${c.licence}`);
      expect(entry).toContain(c.copyright);
    }
  });

  it("keeps a planned component out of the NOTICE and names the work package that copies it", () => {
    const notice = read("NOTICE");
    const hivra = notice.slice(0, notice.indexOf("\nMonoCode\n========"));
    const entries = [...hivra.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    const work = readdirSync(resolve(process.cwd(), "docs/hivra/work"));
    for (const c of CREDITED_COMPONENTS) {
      const wp = plannedAs(c);
      if (!wp) continue;
      // The NOTICE claims code that exists; a planned component's entry waits for the code.
      expect(entries).not.toContain(c.name);
      expect(hivra).not.toContain(c.name);
      expect(work.some((file) => file.startsWith(`${wp}-`))).toBe(true);
    }
  });

  it("does not call a component planned once its code is in the tree", () => {
    for (const c of CREDITED_COMPONENTS) {
      if (!plannedAs(c)) continue;
      for (const path of c.where.split(",").map((part) => part.trim()).filter(Boolean)) {
        expect(existsSync(resolve(process.cwd(), path)), `${c.name} is copied to ${path}`).toBe(false);
      }
    }
  });

  it("keeps Row-Bot's LICENSE beside every file translated from it, and names it in the NOTICE and the credits", () => {
    const licence = read("src/features/memory/model/LICENSE.row-bot");
    expect(licence).toContain("Apache License");
    expect(licence).toContain("Version 2.0, January 2004");
    expect(licence).toContain("Copyright 2026 Row-Bot Contributors");
    const notice = read("NOTICE");
    const rowBot = CREDITED_COMPONENTS.filter((c) => c.url === "https://github.com/siddsachar/row-bot");
    expect(rowBot.length).toBeGreaterThan(0);
    for (const c of rowBot) {
      const files = c.where.split(",").map((part) => part.trim()).filter(Boolean);
      const code = files.filter((file) => !file.includes("LICENSE"));
      expect(code.length, `${c.name} names the file it was translated into`).toBeGreaterThan(0);
      for (const file of code) {
        const copy = `${dirname(file)}/LICENSE.row-bot`;
        expect(existsSync(resolve(process.cwd(), copy)), `${c.name}: ${copy} sits beside ${file}`).toBe(true);
        expect(files, `${c.name} names ${copy} in credits.json`).toContain(copy);
        const entry = notice.slice(notice.indexOf(`- ${c.name}\n`)).split("\n\n")[0];
        expect(entry, `${c.name} names ${copy} in the NOTICE`).toContain(copy);
      }
    }
  });

  it("shows every source and component in the Credits view", () => {
    const html = renderToStaticMarkup(createElement(CreditsList));
    const shown = [...html.matchAll(/data-credit="([^"]+)"/g)].map((m) =>
      m[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
    );
    expect(shown).toEqual([...INSPIRATIONS, ...CREDITED_COMPONENTS].map((s) => s.name));
    for (const s of [...INSPIRATIONS, ...CREDITED_COMPONENTS]) expect(html).toContain(`href="${s.url}"`);
  });
});
