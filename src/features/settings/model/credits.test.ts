// WP-08: README, NOTICE, SOURCES.md and the Credits view must list the same sources. Edit docs/hivra/credits.json and
// the docs together; this test names whichever one drifted.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CREDITED_COMPONENTS, INSPIRATIONS } from "./credits";
import { CreditsList } from "../ui/CreditsList";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

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

  it("gives every component a NOTICE entry with its source, licence and copyright", () => {
    const notice = read("NOTICE");
    const hivra = notice.slice(0, notice.indexOf("\nMonoCode\n========"));
    expect(hivra.startsWith("Hivra\n=====")).toBe(true);
    const entries = [...hivra.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    expect(entries).toEqual(CREDITED_COMPONENTS.map((c) => c.name));
    for (const c of CREDITED_COMPONENTS) {
      const entry = hivra.slice(hivra.indexOf(`- ${c.name}\n`)).split("\n\n")[0];
      expect(entry).toContain(`Source: ${c.url}`);
      expect(entry).toContain(`License: ${c.licence}`);
      expect(entry).toContain(c.copyright);
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
