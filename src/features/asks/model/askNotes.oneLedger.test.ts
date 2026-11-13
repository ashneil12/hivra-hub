// What a first mate is told once the ledgers are one (sc-18): each open ask carries its id, so a job can be handed the ask
// (`asks` on delegate_task), an ask sent back by a failed job says why, and a quiet ask (a lone short ask, or one the hub
// owns) is on the Chief's list but is not put in front of a first mate, nudged about or listed as owed until someone moves it.
import { describe, expect, it } from "vitest";
import type { Session } from "../../sessions/model/session";
import { askDigest, askNudge, openAsksKey, openAsksNote, staleAsks } from "./askNotes";
import { askForMate, emptyAskDoc, isOwed, isQuiet, openAsksFor, withChange, withHeard, type AskDoc } from "./asks";

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function heard(quiet: boolean, ...quotes: string[]): AskDoc {
  return withHeard(emptyAskDoc(T0), {
    mateId: "mate",
    sessionId: "chat-1",
    blockId: "blk-aaaaaaaaaaaa",
    list: { asks: quotes.map((quote) => ({ quote, summary: quote, kind: "do" as const })), maybes: [] },
    by: "rules",
    now: T0,
    ...(quiet ? { quiet: true } : {}),
  });
}
const move = (doc: AskDoc, id: string, change: Parameters<typeof withChange>[2], by: "ash" | "mate" | "app", now: number): AskDoc => {
  const out = withChange(doc, id, change, by, now);
  if ("problem" in out) throw new Error(out.problem);
  return out.doc;
};

describe("the id a job is handed", () => {
  it("is on each line of the open list and of asks.list, and the list says what to do with it", () => {
    const doc = heard(false, "please fix the save bug on the settings page", "make the export remember the last folder");
    const note = openAsksNote(doc, "mate", "app") as string;
    for (const ask of doc.asks) {
      expect(note).toContain(`(id ${ask.id})`);
      expect(askForMate(ask).id).toBe(ask.id);
    }
    expect(note).toContain("- ask 1:");
    expect(note).toContain("pass its id in the job's `asks`");
  });

  it("an ask sent back by a job says why, so the first mate reads it; a plain not-started ask shows no state", () => {
    const doc = heard(false, "please fix the save bug on the settings page", "make the export remember the last folder");
    const back = move(doc, doc.asks[0].id, { status: "heard", note: 'Its job failed ("Fix the save bug"): The checks failed. Back on the list.' }, "app", T0 + 1000);
    const note = openAsksNote(back, "mate", "app") as string;
    expect(note).toContain('[not started: Its job failed ("Fix the save bug"): The checks failed. Back on the list.]');
    const plain = note.split("\n").find((line) => line.startsWith("- ask 2:")) as string;
    expect(plain).not.toContain("[");
  });
});

describe("a quiet ask", () => {
  it("is not owed, not in front of the first mate, not in the open-list key, and not nudged or named in the daily check", () => {
    const doc = heard(true, "fix the save bug");
    const [ask] = doc.asks;
    expect(isQuiet(ask)).toBe(true);
    expect(isOwed(ask)).toBe(false);
    expect(openAsksFor(doc, "mate")).toEqual([]);
    expect(openAsksNote(doc, "mate", "app")).toBeUndefined();
    expect(openAsksKey(doc, "mate")).toBe("");
    const done = { id: "chat-1", busy: false, blocks: [{ id: "blk-aaaaaaaaaaaa", role: "user", text: "fix the save bug" }, { id: "a1", role: "assistant", text: "Fixed." }] } as unknown as Session;
    expect(askNudge(done, doc, "mate", "app", new Set())).toBeUndefined();
    expect(staleAsks(doc, "mate", T0 + 5 * DAY)).toEqual([]);
    expect(askDigest(doc, "mate", "app", T0 + 5 * DAY)).toBeUndefined();
  });

  it("stops being quiet the moment someone moves it: a job starting it puts it in front of the first mate", () => {
    const doc = heard(true, "fix the save bug");
    const moved = move(doc, doc.asks[0].id, { status: "started", note: "Handed to a worker: Fix the save bug" }, "app", T0 + 1000);
    expect(isQuiet(moved.asks[0])).toBe(false);
    expect(openAsksNote(moved, "mate", "app")).toContain('"fix the save bug" [working: Handed to a worker: Fix the save bug]');
    // Started and left for three days: the daily check names it like any other.
    expect(staleAsks(moved, "mate", T0 + 5 * DAY).map((ask) => ask.n)).toEqual([1]);
  });

  it("a loud ask from the same message is unchanged by a quiet one beside it", () => {
    const loud = heard(false, "please fix the save bug on the settings page");
    expect(isQuiet(loud.asks[0])).toBe(false);
    expect(openAsksFor(loud, "mate")).toHaveLength(1);
  });
});
