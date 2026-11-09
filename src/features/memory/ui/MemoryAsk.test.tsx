// WP-100: the question the Memory screen asks. The answers are the four the model keeps, in plain words.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { memoryId, type MemoryItem } from "../model/doc";
import { MemoryAsk } from "./MemoryAsk";

const ITEM: MemoryItem = {
  id: memoryId(["notes-lead", "add", "likes small commits"]),
  mateId: "notes-lead",
  action: "add",
  text: "Likes small commits",
  state: "confirmed",
  source: { kind: "turn", ref: "turn-1", label: "turn-1" },
  evidence: "I like small commits",
  support: 1,
  against: 0,
  createdAt: 0,
  updatedAt: 0,
  fade: 0.05,
};

function render(busy = false): string {
  return renderToStaticMarkup(createElement(MemoryAsk, { item: ITEM, busy, onAnswer: () => undefined }));
}

it("asks whether the fact is still true, and shows the fact itself", () => {
  const html = render();
  expect(html).toContain("Is this still true?");
  expect(html).toContain("Likes small commits");
  expect(html).toContain(`data-ask="${ITEM.id}"`);
});

it("offers the four answers in plain words, with no typed words taken as an answer", () => {
  const html = render();
  expect(html).toContain(">Still true<");
  expect(html).toContain(">It changed<");
  expect(html).toContain(">No longer true<");
  expect(html).toContain(">Not sure<");
  // The new wording is typed after "It changed", never instead of choosing.
  expect(html).not.toContain("What is true now");
});

it("holds every answer while the screen is busy saving another", () => {
  const html = render(true);
  for (const label of ["Still true", "It changed", "No longer true", "Not sure"]) {
    expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
  }
});
