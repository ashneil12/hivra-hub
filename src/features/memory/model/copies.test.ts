// WP-100: one memory can live in more than one place. Deleting a fact must reach every copy the app can take out,
// and the screen must say plainly about any copy it cannot. Tests first.

import { describe, expect, it } from "vitest";
import { memoryId, type MemoryItem } from "./doc";
import { copiesOf, deleteNote } from "./copies";

function fact(extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
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
    ...extra,
  };
}

function skill(extra: Partial<MemoryItem> = {}): MemoryItem {
  return fact({
    action: "skill",
    skill: { name: "reviewing-a-diff", lesson: "Read the diff before commenting." },
    text: "Read the diff before commenting.",
    ...extra,
  });
}

describe("copiesOf", () => {
  it("names the chat every fact came from, and the screen cannot remove it", () => {
    const copies = copiesOf(fact());
    expect(copies).toEqual([{ kind: "chat", removable: false, what: "The chat it came from" }]);
  });

  it("names the skill file a kept skill put its lesson in, and the screen can remove it", () => {
    const copies = copiesOf(skill());
    expect(copies.map((copy) => copy.kind)).toEqual(["skill", "changes", "chat"]);
    expect(copies[0]).toMatchObject({ kind: "skill", removable: true });
    expect(copies[0].what).toBe("The reviewing a diff skill file");
    // The Bot changes row that applied the lesson is a record of the change, not a copy the screen can edit.
    expect(copies[1]).toMatchObject({ kind: "changes", removable: false });
  });

  it("does not call an unaccepted skill file a copy, because nothing was written there yet", () => {
    const copies = copiesOf(skill({ state: "unreviewed" }));
    expect(copies.map((copy) => copy.kind)).toEqual(["chat"]);
  });

  it("names the history draft an imported fact was read from", () => {
    const copies = copiesOf(fact({ source: { kind: "import", ref: "hi-abcdef01", label: "notes" } }));
    expect(copies.map((copy) => copy.kind)).toEqual(["draft", "chat"]);
    expect(copies[0]).toMatchObject({ kind: "draft", removable: false, what: "The draft it was imported from" });
  });
});

describe("deleteNote", () => {
  it("says what was deleted and what still holds it", () => {
    expect(deleteNote(copiesOf(fact()), true)).toBe("Deleted. The chat it came from still has its words.");
  });

  it("says the skill file is clean once the lesson is gone", () => {
    expect(deleteNote(copiesOf(skill()), true)).toBe(
      "Deleted. Its lesson is no longer in the reviewing a diff skill file. Its change is still listed under Settings, Changes, Bot changes. The chat it came from still has its words.",
    );
  });

  it("says plainly when the skill file still has the lesson", () => {
    expect(deleteNote(copiesOf(skill()), false)).toBe(
      "Deleted here, but the reviewing a diff skill file still has that lesson. Its change is still listed under Settings, Changes, Bot changes. The chat it came from still has its words.",
    );
  });

  it("names the draft an imported fact was read from", () => {
    const copies = copiesOf(fact({ source: { kind: "import", ref: "hi-abcdef01", label: "notes" } }));
    expect(deleteNote(copies, true)).toBe(
      "Deleted. The draft it was imported from still has its line. The chat it came from still has its words.",
    );
  });

  it("uses plain words only: no dashes of the long kind anywhere", () => {
    const notes = [deleteNote(copiesOf(fact()), true), deleteNote(copiesOf(skill()), false)];
    for (const note of notes) expect(note).not.toMatch(/[–—]/);
  });
});
