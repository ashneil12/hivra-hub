// WP-103: every memory says where it came from, in one plain line, from fields it already has.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { memoryId, type MemoryItem } from "../model/doc";
import { MemoryProvenance, memoryDate, memoryProvenance } from "./MemoryProvenance";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const ON_3_NOV = new Date(2026, 10, 3, 10, 0).getTime();

function item(extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: memoryId(["notes-lead", "add", "always use pnpm"]),
    mateId: "notes-lead",
    action: "add",
    text: "Always use pnpm",
    state: "unreviewed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: "Always use pnpm, never npm.",
    support: 1,
    against: 0,
    createdAt: ON_3_NOV,
    updatedAt: ON_3_NOV,
    ...extra,
  };
}

it("says what a rules memory is, when it was said, and quotes the person", () => {
  expect(memoryProvenance(item({ via: "rules" }), NOW)).toBe("Said by you on 3 Nov: 'Always use pnpm, never npm.' (written by the rules).");
});

it("says which engine proposed a crew memory, and when", () => {
  expect(memoryProvenance(item({ via: "crew", by: "claude" }), NOW)).toBe("Proposed from a chat on 3 Nov by Claude.");
  // Old data with no engine still says when it came from, just less.
  expect(memoryProvenance(item({ via: "crew" }), NOW)).toBe("Proposed from a chat on 3 Nov.");
  // And old data with no tier at all says the same as a crew memory without an engine.
  expect(memoryProvenance(item(), NOW)).toBe("Proposed from a chat on 3 Nov.");
});

it("says a cheap memory came from the model the person picked", () => {
  expect(memoryProvenance(item({ via: "cheap" }), NOW)).toBe("Proposed from a chat on 3 Nov by a cheap model you picked.");
});

it("names the project an imported memory came over from", () => {
  const imported = item({ source: { kind: "import", ref: "hi-notes", label: "notes" } });
  expect(memoryProvenance(imported, NOW)).toBe("Brought over from notes on 3 Nov.");
});

it("says the year when it was not this year, and keeps quiet about a date it cannot read", () => {
  expect(memoryDate(ON_3_NOV, NOW)).toBe("3 Nov");
  expect(memoryDate(Date.parse("2025-11-03T10:00:00Z"), NOW)).toMatch(/^3 Nov 2025$/);
  expect(memoryProvenance(item({ via: "rules", createdAt: 0, updatedAt: 0 }), NOW)).toBe(
    "Said by you: 'Always use pnpm, never npm.' (written by the rules).",
  );
  expect(memoryDate(Number.NaN, NOW)).toBe("");
});

it("keeps the quote to one short line, and still says where a memory with no quote came from", () => {
  const long = memoryProvenance(item({ via: "rules", evidence: "x".repeat(400) }), NOW);
  expect(long.length).toBeLessThan(190);
  expect(long.endsWith("…' (written by the rules).")).toBe(true);
  expect(memoryProvenance(item({ via: "rules", evidence: "   " }), NOW)).toBe("Said by you on 3 Nov (written by the rules).");
});

it("renders the line on the screen", () => {
  const html = renderToStaticMarkup(createElement(MemoryProvenance, { item: item({ via: "rules" }), now: NOW }));
  expect(html).toContain("data-provenance");
  expect(html).toContain("Said by you on 3 Nov");
});
