// r99 (B5 20261030-235843-7879): the Lead re-states its open asks on every bubble so the card stays up. Ash reads each
// question once: a later reply that repeats one leaves it out, and the card still has it.
import { expect, it } from "vitest";
import { repeatedAsks, withoutAskMarkers } from "./askMarkers";

const first = "Preview is under way.\n\nNeeds the user: Which shortcut should open a new chat?\nMy pick: Cmd+N";
const later =
  "The preview landed.\n\nNeeds the user: Which shortcut should open a new chat?\nMy pick: Cmd+N\n\nNeeds the user: What should a share link do?\nMy pick: open it read-only";

it("shows a repeated question once, keeps the new one, and the card's source text stays as written", () => {
  const blocks = [
    { id: "a", role: "assistant", text: first },
    { id: "u", role: "user", text: "ok" },
    { id: "b", role: "assistant", text: later },
  ];
  const repeats = repeatedAsks(blocks);
  expect(repeats.has("a")).toBe(false);
  const shown = withoutAskMarkers(later, repeats.get("b"));
  expect(shown).not.toContain("shortcut");
  expect(shown).toContain("The preview landed.");
  expect(shown).toContain("What should a share link do?");
  expect(shown).toContain("I'd go with open it read-only");
  expect(withoutAskMarkers(first)).toContain("Which shortcut should open a new chat?");
  expect(blocks[2]!.text).toContain("Needs the user: Which shortcut");
});

it("a reply that is only repeats reads as one short line, not an empty bubble", () => {
  const only = "Needs the user: Which shortcut should open a new chat?\nMy pick: Cmd+N";
  const repeats = repeatedAsks([
    { id: "a", role: "assistant", text: first },
    { id: "b", role: "assistant", text: only },
  ]);
  expect(withoutAskMarkers(only, repeats.get("b"))).toBe("Still waiting on your answers on the card.");
});
