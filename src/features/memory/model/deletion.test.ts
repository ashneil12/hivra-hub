// WP-100: deleting a memory reaches every copy it has. The doc row goes first; then the skill file's lesson. A skill
// file that cannot be reached is not a lost delete: the fact is gone from the screen and the note says what is left.

import { describe, expect, it } from "vitest";
import { settleTurn } from "./curator";
import { emptyDoc, type MemoryDoc } from "./doc";
import { acceptItem, commitDoc } from "./review";
import { deleteMemory } from "./deletion";

const NOW = Date.parse("2026-03-01T00:00:00Z");

function harness(doc: MemoryDoc, disk: Map<string, string>) {
  let current = doc;
  let revision = 1;
  return {
    disk,
    get doc() {
      return current;
    },
    load: async () => ({ ...current, revision }),
    save: async (expected: number, next: MemoryDoc) => {
      if (expected !== revision) return false;
      current = next;
      revision += 1;
      return true;
    },
    /** A skill's lesson is its file's one bullet, as learnSkillLesson wrote it. */
    lessonOf: (name: string) => disk.get(name) ?? "",
    setLesson: (name: string, lesson: string) => disk.set(name, lesson),
  };
}

function skillDoc(): MemoryDoc {
  return settleTurn(
    emptyDoc(1),
    { mateId: "notes-lead", turnId: "turn-1", user: "I always read the diff first.", assistant: "I'll do that.", now: NOW },
    {
      kind: "reply",
      text: JSON.stringify({ kind: "skill", name: "Reviewing a diff", lesson: "Read the diff before commenting.", evidence: "read the diff" }),
    },
  ).doc;
}

function confirmedSkill(doc: MemoryDoc): MemoryDoc {
  return acceptItem(doc, doc.items[0].id, NOW).doc;
}

describe("deleteMemory", () => {
  it("takes a plain fact out of the doc and names the chat that still has it", async () => {
    const doc = settleTurn(
      emptyDoc(1),
      { mateId: "notes-lead", turnId: "turn-1", user: "I like small commits.", assistant: "Noted.", now: NOW },
      { kind: "reply", text: JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "small commits" }) },
    ).doc;
    const store = harness(doc, new Map());
    const result = await deleteMemory(store.load, store.save, async () => undefined, doc.items[0].id);
    expect(result.deleted).toBe(true);
    expect(result.doc.items).toEqual([]);
    expect(result.note).toBe("Deleted. The chat it came from still has its words.");
  });

  it("takes a kept skill's lesson out of its file too", async () => {
    const doc = confirmedSkill(skillDoc());
    const store = harness(doc, new Map([["reviewing-a-diff", "- Read the diff before commenting.\n"]]));
    const result = await deleteMemory(
      store.load,
      store.save,
      async (name, lesson) => {
        const text = store.lessonOf(name);
        store.setLesson(name, text.includes(`- ${lesson}`) ? text.replace(`- ${lesson}\n`, "") : text);
      },
      doc.items[0].id,
    );
    expect(result.deleted).toBe(true);
    expect(result.doc.items).toEqual([]);
    expect(store.lessonOf("reviewing-a-diff")).not.toContain("Read the diff before commenting.");
    expect(result.note).toBe(
      "Deleted. Its lesson is no longer in the reviewing a diff skill file. Its change is still listed under Settings, Changes, Bot changes. The chat it came from still has its words.",
    );
  });

  it("says plainly when the skill file could not be cleared, and still deletes the fact", async () => {
    const doc = confirmedSkill(skillDoc());
    const store = harness(doc, new Map([["reviewing-a-diff", "- Read the diff before commenting.\n"]]));
    const result = await deleteMemory(store.load, store.save, async () => {
      throw new Error("the folder is away");
    }, doc.items[0].id);
    expect(result.deleted).toBe(true);
    expect(result.doc.items).toEqual([]);
    expect(store.lessonOf("reviewing-a-diff")).toContain("Read the diff before commenting.");
    expect(result.note).toBe(
      "Deleted here, but the reviewing a diff skill file still has that lesson. Its change is still listed under Settings, Changes, Bot changes. The chat it came from still has its words.",
    );
  });

  it("does not touch the skill file when the delete never lands, and the screen can try again", async () => {
    const doc = confirmedSkill(skillDoc());
    const store = harness(doc, new Map([["reviewing-a-diff", "- Read the diff before commenting.\n"]]));
    let asked = false;
    // Another window saved first, so every attempt meets a newer revision.
    store.save = async () => false;
    await expect(
      deleteMemory(store.load, store.save, async () => {
        asked = true;
      }, doc.items[0].id),
    ).rejects.toThrow("Memory could not be saved this time.");
    expect(asked).toBe(false);
    expect(store.lessonOf("reviewing-a-diff")).toContain("Read the diff before commenting.");
    // The fact is still there: nothing was deleted, and the screen can try again.
    expect(store.doc.items).toHaveLength(1);
  });

  it("names an imported fact's draft, which it leaves alone", async () => {
    const doc: MemoryDoc = {
      ...emptyDoc(1),
      items: [
        {
          id: "mem-0123456789abcdef",
          mateId: "notes-lead",
          action: "add",
          text: "Decides on Tuesday [src: sess-1 #m1]",
          state: "confirmed",
          source: { kind: "import", ref: "hi-abcdef01", label: "notes" },
          evidence: "Decides on Tuesday",
          support: 1,
          against: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    const store = harness(doc, new Map());
    const result = await deleteMemory(store.load, store.save, async () => undefined, doc.items[0].id);
    expect(result.note).toBe(
      "Deleted. The draft it was imported from still has its line. The chat it came from still has its words.",
    );
  });

  it("an id that is not there changes nothing and says nothing", async () => {
    const store = harness(emptyDoc(1), new Map());
    const result = await deleteMemory(store.load, store.save, async () => undefined, "mem-ffffffffffffffff");
    expect(result.deleted).toBe(false);
    expect(result.note).toBe("");
  });

  it("a save that is refused twice still lands on the next try", async () => {
    const doc = confirmedSkill(skillDoc());
    const store = harness(doc, new Map());
    const real = store.save;
    let fails = 2;
    store.save = async (expected, next) => (fails-- > 0 ? false : real(expected, next));
    // commitDoc's five attempts see two refusals, so the delete lands on the third.
    const result = await deleteMemory(store.load, store.save, async () => undefined, doc.items[0].id);
    expect(result.deleted).toBe(true);
    expect(result.doc.items).toEqual([]);
  });

  it("works through commitDoc like every other change", async () => {
    const doc = confirmedSkill(skillDoc());
    const store = harness(doc, new Map());
    const before = doc.generation;
    await commitDoc(store.load, store.save, (current) => current);
    const result = await deleteMemory(store.load, store.save, async () => undefined, doc.items[0].id);
    expect(result.doc.generation).toBeGreaterThan(before);
  });
});
