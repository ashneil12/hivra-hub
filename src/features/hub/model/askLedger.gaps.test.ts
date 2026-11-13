// @vitest-environment happy-dom
// Gaps in the hub ask ledger (hub/model/askLedger.ts, the "You asked" list) and the dump check that feeds and settles it
// (formal/asks/README.md, gaps H1 to H3), each as the shortest run that shows it. H1 was FIXED by sc-17-ask-fixes: its
// test was flipped by that fix and now asserts the correct behaviour, on the same trace. H2 and H3 still pin what the
// code does TODAY; a change that fixes one fails its test here, so update the test then (and the README line).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";
import { dropAsk, extractAsks, handleAsk, openAsks, parkAsk, readAskLedger, recordAskText, type LedgerAsk } from "./askLedger";
import { lookAtDumps, readDumpNotes } from "./dumpCheck";

beforeEach(() => {
  localStorage.clear();
});

const AT = 1_800_000_000_000;
const say = (i: number) => recordAskText(`chat-${i}`, `blk-${i}`, `Please fix the thing number ${i} on the settings page`, AT + i);
/** The ledger as the last window wrote it: `count` rows, the oldest first (blk-0 is the oldest), each in the status given for its index. */
function seed(count: number, status: LedgerAsk["status"] | ((i: number) => LedgerAsk["status"])) {
  const rows: LedgerAsk[] = Array.from({ length: count }, (_, i) => ({
    id: `seed-${i}`,
    chatId: `chat-${i}`,
    blockId: `blk-${i}`,
    title: `thing ${i}`,
    words: `Please fix the thing number ${i} on the settings page`,
    at: AT + i,
    status: typeof status === "function" ? status(i) : status,
    said: 1,
  }));
  localStorage.setItem("monocode:hub-ask-ledger", JSON.stringify(rows));
}
const blocks = () => readAskLedger().map((row) => row.blockId);

// FLIPPED by sc-17-ask-fixes (gap H1). This test used to assert that 400 rows remained and the first ask was gone. The
// trace is unchanged (401 asks said, none settled); it now asserts all 401 are kept, the first one too.
describe("H1 (fixed): the hub ledger's 400-row limit never evicts an open row", () => {
  it("401 asks said, none settled: every one is kept, the first too", () => {
    for (let i = 0; i < 401; i += 1) say(i);
    expect(readAskLedger()).toHaveLength(401);
    expect(openAsks()).toHaveLength(401);
    expect(readAskLedger().some((row) => row.blockId === "blk-0")).toBe(true);
    expect(readAskLedger().some((row) => row.blockId === "blk-400")).toBe(true);
  });

  it("past the limit, closed rows (handled, parked, dropped) go oldest first and the open ones stay in order", () => {
    for (let i = 0; i < 400; i += 1) say(i);
    const id = (n: number) => readAskLedger()[n].id;
    handleAsk(id(10), "done in the build");
    parkAsk(id(20));
    dropAsk(id(30));
    handleAsk(id(40), "done in the build");
    for (let i = 400; i < 403; i += 1) say(i);
    // 403 rows, 4 closed in the middle: the three oldest closed go (blk-10, blk-20, blk-30), not the three oldest rows.
    // blk-40 stays: the limit is met without it.
    expect(readAskLedger()).toHaveLength(400);
    expect(blocks().slice(0, 3)).toEqual(["blk-0", "blk-1", "blk-2"]);
    for (const gone of ["blk-10", "blk-20", "blk-30"]) expect(blocks()).not.toContain(gone);
    expect(blocks()).toContain("blk-40");
    expect(blocks().slice(-3)).toEqual(["blk-400", "blk-401", "blk-402"]);
    expect(openAsks()).toHaveLength(399);
  });

  it("the limit still holds for closed rows: 400 closed and a new open ask keeps the newest 400", () => {
    seed(400, "handled");
    say(400);
    expect(readAskLedger()).toHaveLength(400);
    expect(blocks()[0]).toBe("blk-1");
    expect(blocks().at(-1)).toBe("blk-400");
    expect(openAsks()).toHaveLength(1);
  });

  it("more open rows than the limit: every closed row goes, no open row does", () => {
    seed(450, (i) => (i < 5 ? "handled" : "open"));
    say(450);
    expect(readAskLedger()).toHaveLength(446);
    expect(openAsks()).toHaveLength(446);
    expect(blocks()[0]).toBe("blk-5");
  });

  it("400 open rows and one more: all 401 are kept", () => {
    seed(400, "open");
    say(400);
    expect(readAskLedger()).toHaveLength(401);
    expect(openAsks()).toHaveLength(401);
  });
});

describe("KNOWN GAP H2: the hub extractor stops after six asks in one message", () => {
  it("a message with eight asks writes six rows; the last two are never written down", () => {
    const text = [
      "Please fix the harbour invoice export.",
      "Please add a test for the lantern login screen.",
      "Please check the orchard weekly report email.",
      "Please rename the granite pricing page heading.",
      "Please remove the velvet onboarding tour.",
      "Please update the tundra release notes.",
      "Please look at the marble backup job schedule.",
      "Please write up the quartz search changes.",
    ].join("\n");
    const found = extractAsks(text);
    expect(found).toHaveLength(6);
    expect(found.map((ask) => ask.words)).not.toContain("Please look at the marble backup job schedule.");
    expect(found.map((ask) => ask.words)).not.toContain("Please write up the quartz search changes.");
    recordAskText("chat-1", "blk-1", text, 1_800_000_000_000);
    expect(readAskLedger()).toHaveLength(6);
  });
});

describe("KNOWN GAP H3: a look that fails or times out counts as 'nothing missed' and the dump is never looked at again", () => {
  const dump = [
    "Please fix the harbour invoice export so it stops dropping the last row.",
    "Please add a test for the lantern login screen.",
    "Please rename the granite pricing page heading.",
  ].join("\n");
  const session = {
    id: "chat-1",
    busy: false,
    queuedMessages: [],
    blocks: [
      { id: "blk-dump", role: "user", text: dump, startedAt: 1_800_000_000_000 },
      { id: "a-1", role: "assistant", text: "Example: I fixed the invoice export." },
    ],
  } as unknown as Session;

  it("the first look throws: nothing is offered, the note is forgotten, and a later look that would find a gap is never run", async () => {
    const offer = vi.fn();
    const failing = vi.fn(async () => {
      throw new Error("timed out after 90 s");
    });
    await lookAtDumps([session], failing, offer, { now: 1_800_000_001_000 });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(offer).not.toHaveBeenCalled();
    expect(readDumpNotes()).toEqual([]);
    // The same dump, the next pass, with a look that works and would have found something missed:
    const working = vi.fn(async () => "- the pricing page heading was never renamed");
    await lookAtDumps([session], working, offer, { now: 1_800_000_002_000 });
    expect(working).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();
  });
});
