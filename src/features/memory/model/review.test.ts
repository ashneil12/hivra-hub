import { describe, expect, it } from "vitest";
import { freshDoc, settleTurn } from "./curator";
import { emptyDoc, parseDoc, type MemoryDoc } from "./doc";
import { acceptImport, acceptItem, commitDoc, deleteItem, editItem, rejectImport, rejectItem, searchMemory } from "./review";

const NOW = Date.parse("2026-03-01T00:00:00Z");
const SECRET = "sk-ant-api03-abcdefghijklmnopqrst";

function withFact(): MemoryDoc {
  return settleTurn(
    freshDoc(),
    { mateId: "notes-lead", turnId: "turn-1", user: "I like small commits.", assistant: "Noted.", now: NOW },
    { kind: "reply", text: JSON.stringify({ kind: "add", text: "Likes small commits", evidence: "small commits" }) },
  ).doc;
}

describe("review", () => {
  it("accepts and rejects a skill once", () => {
    const doc = settleTurn(
      freshDoc(),
      { mateId: "notes-lead", turnId: "turn-1", user: "I always read the diff first.", assistant: "I'll do that.", now: NOW },
      {
        kind: "reply",
        text: JSON.stringify({ kind: "skill", name: "Reviewing a diff", lesson: "Read the diff before commenting.", evidence: "read the diff" }),
      },
    ).doc;
    const accepted = acceptItem(doc, doc.items[0].id, NOW);
    expect(accepted.skill?.name).toBe("reviewing-a-diff");
    expect(accepted.doc.items[0].state).toBe("confirmed");
    expect(acceptItem(accepted.doc, doc.items[0].id, NOW).skill).toBeUndefined();
    expect(rejectItem(doc, doc.items[0].id).items).toEqual([]);
    expect(rejectItem(accepted.doc, doc.items[0].id).items).toHaveLength(1);
  });

  it("edits, deletes, and searches without losing the id", () => {
    const doc = withFact();
    const id = doc.items[0].id;
    const edited = editItem(doc, id, "Likes tiny commits", NOW + 5);
    expect(edited.items[0]).toMatchObject({ id, text: "Likes tiny commits", state: "edited" });
    expect(editItem(edited, id, "   ", NOW).items[0].text).toBe("Likes tiny commits");
    expect(editItem(edited, id, `keep ${SECRET}`, NOW).items[0].text).toBe("Likes tiny commits");
    expect(deleteItem(edited, id).items).toEqual([]);
    expect(deleteItem(edited, "mem-0000000000000000")).toBe(edited);
    const friday = settleTurn(
      edited,
      { mateId: "notes-lead", turnId: "turn-2", user: "Reviews happen on Friday.", assistant: "Friday it is.", now: NOW },
      { kind: "reply", text: JSON.stringify({ kind: "add", text: "Reviews happen on Friday", evidence: "on Friday" }) },
    ).doc;
    expect(searchMemory(friday.items, "friday").map((item) => item.text)).toEqual(["Reviews happen on Friday"]);
    expect(searchMemory(friday.items, "").map((item) => item.text)).toEqual(["Likes tiny commits", "Reviews happen on Friday"]);
    expect(searchMemory(friday.items, "zzzz")).toEqual([]);
  });

  it("accepts a sourced import and rejects one, dropping a secret and an unsourced line", () => {
    const markdown = [`Decides on Tuesday [src: sess-1 #m1]`, `No source`, `token ${SECRET} [src: sess-1 #m2]`, `Decides on Tuesday [src: sess-1 #m1]`].join("\n");
    const accepted = acceptImport(freshDoc(), { id: "hi-abcdef01", project: "notes", markdown }, NOW);
    expect(accepted.items).toHaveLength(1);
    expect(accepted.items[0]).toMatchObject({ state: "confirmed", mateId: "notes-lead", source: { kind: "import", ref: "hi-abcdef01" } });
    expect(JSON.stringify(accepted)).not.toContain("sk-ant");
    expect(accepted.imports["hi-abcdef01"]).toBe("confirmed");
    expect(acceptImport(accepted, { id: "hi-abcdef01", project: "notes", markdown }, NOW).items).toHaveLength(1);
    const rejected = rejectImport(freshDoc(), "hi-abcdef01");
    expect(rejected.imports["hi-abcdef01"]).toBe("rejected");
    expect(rejected.items).toEqual([]);
    const empty = acceptImport(freshDoc(), { id: "hi-empty", project: "notes", markdown: "No source\n" }, NOW);
    expect(empty.items).toEqual([]);
    expect(empty.imports["hi-empty"]).toBe("rejected");
  });

  it("saves on top of the latest revision, and a broken file is an empty doc", async () => {
    let current = withFact();
    const saves: number[] = [];
    const load = async () => current;
    const save = async (revision: number, doc: MemoryDoc) => {
      saves.push(revision);
      if (saves.length === 1) return false;
      if (revision !== current.revision) return false;
      current = { ...doc, revision: revision + 1 };
      return true;
    };
    const next = await commitDoc(load, save, (doc) => editItem(doc, doc.items[0].id, "Likes tiny commits", NOW));
    expect(saves).toEqual([0, 0]);
    expect(next.items[0].text).toBe("Likes tiny commits");
    expect(next.revision).toBe(1);
    expect(parseDoc(null).items).toEqual([]);
    expect(parseDoc("{").items).toEqual([]);
    expect(parseDoc({ items: [{ id: "nope", text: "x" }], doneTurns: [SECRET], imports: { "../x": "confirmed" } }).items).toEqual([]);
    expect(parseDoc({ items: [{ id: "nope" }] }).doneTurns).toEqual([]);
    const thrown = commitDoc(
      async () => emptyDoc(),
      async () => {
        throw new Error("busy");
      },
      (doc) => ({ ...doc, generation: doc.generation + 1, doneTurns: ["a:b"] }),
    );
    await expect(thrown).rejects.toThrow(/could not be saved/i);
  });
});
