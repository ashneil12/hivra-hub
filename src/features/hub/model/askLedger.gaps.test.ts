// @vitest-environment happy-dom
// Gaps in the hub ask path (formal/asks/README.md, gaps H1 to H3), each as the shortest run that shows it. They were first
// written against the old hub ledger's own rows (a 400-row key in localStorage). That ledger is folded into the one ask
// ledger (asks/model/asks.ts), so H1 and H2 now run against the ledger the Chief's "You asked" list reads, with the same
// traces: H1 asserts no open ask is lost to a limit (the one ledger keeps every open row and limits only closed ones), and
// H2 asserts the six-ask cap is gone on the path a hub chat's asks take now (the old regex's own cap of six is pinned).
// H3 (a look that fails) is about the dump check and is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askDocForDisk, CLOSED_CAP, emptyAskDoc, type Ask, type AskDoc } from "../../asks/model/asks";
import { askStore, setAskStore } from "../../asks/model/askStore";
import { askedRows } from "../../asks/model/askedView";
import { freshAskStore, openAsksIn, sayInHub } from "../../asks/testbed/hubAsks";
import type { Session } from "../../sessions/model/session";
import { extractAsks } from "./askLedger";
import { lookAtDumps, readDumpNotes } from "./dumpCheck";

beforeEach(() => {
  localStorage.clear();
  freshAskStore();
});
afterEach(() => setAskStore(undefined));

const AT = 1_800_000_000_000;
const say = (i: number) => sayInHub(`chat-${i}`, `blk-${i}`, `Please fix the thing number ${i} on the settings page`, AT + i);

/** A ledger as the last window wrote it: `count` asks, the oldest first, each in the status given for its index. */
function seeded(count: number, status: Ask["status"] | ((i: number) => Ask["status"])): AskDoc {
  const asks: Ask[] = Array.from({ length: count }, (_, i) => ({
    id: `ask-${i + 1}-blk${i}`,
    n: i + 1,
    mateId: "hub.chats",
    sessionId: `chat-${i}`,
    blockId: `blk-${i}`,
    quote: `Please fix the thing number ${i} on the settings page`,
    summary: `thing ${i}`,
    kind: "do",
    status: typeof status === "function" ? status(i) : status,
    heardBy: "rules",
    createdAt: AT + i,
    updatedAt: AT + i,
    history: [{ at: AT + i, status: "heard", by: "app" }],
  }));
  return { ...emptyAskDoc(AT), next: count + 1, asks };
}
const blocks = (doc: Pick<AskDoc, "asks">) => doc.asks.map((ask) => ask.blockId);

// H1 was FIXED by sc-17-ask-fixes for the old ledger (its 400-row limit evicted open rows) and is asserted here for the one
// ledger: the same trace, 401 asks said and none settled, keeps all 401 and the first one too.
describe("H1 (fixed): a limit never evicts an open ask", () => {
  it("401 asks said, none settled: every one is kept, the first too", async () => {
    for (let i = 0; i < 401; i += 1) await say(i);
    expect(askedRows(askStore().doc())).toHaveLength(401);
    expect(openAsksIn()).toHaveLength(401);
    expect(blocks(askStore().doc())).toContain("blk-0");
    expect(blocks(askStore().doc())).toContain("blk-400");
  }, 30_000);

  it("past the limit on closed asks (2000), the oldest closed go first and every open one stays in order", () => {
    // 2003 closed in the middle of the run, and open ones either side: the three oldest closed go, nothing open does.
    const doc = seeded(2010, (i) => (i >= 5 && i < 2008 ? "done" : "heard"));
    const kept = askDocForDisk(doc).asks;
    expect(CLOSED_CAP).toBe(2000);
    expect(kept).toHaveLength(2007);
    const heldBlocks = blocks({ asks: kept });
    for (const gone of ["blk-5", "blk-6", "blk-7"]) expect(heldBlocks).not.toContain(gone);
    expect(heldBlocks).toContain("blk-8");
    expect(kept.filter((ask) => ask.status === "heard").map((ask) => ask.blockId)).toEqual(["blk-0", "blk-1", "blk-2", "blk-3", "blk-4", "blk-2008", "blk-2009"]);
  });

  it("closed asks at the limit are all kept, and a new open ask costs none of them", () => {
    const doc = seeded(2000, "done");
    expect(askDocForDisk({ ...doc, asks: [...doc.asks, ...seeded(1, "heard").asks.map((ask) => ({ ...ask, id: "ask-9999-new", n: 9999, blockId: "blk-new" }))] }).asks).toHaveLength(2001);
  });

  it("far more open asks than any limit: every open one is kept, whatever else goes", () => {
    const doc = seeded(2600, (i) => (i < 5 ? "done" : "heard"));
    const kept = askDocForDisk(doc).asks;
    expect(kept).toHaveLength(2600);
    expect(kept.filter((ask) => ask.status === "heard")).toHaveLength(2595);
  });
});

describe("H2 (fixed on the combined path): the old hub extractor stopped after six asks in one message", () => {
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

  it("the old regex still stops at six; a hub chat's message with eight asks now writes all eight", async () => {
    const found = extractAsks(text);
    expect(found).toHaveLength(6);
    expect(found.map((ask) => ask.words)).not.toContain("Please look at the marble backup job schedule.");
    await sayInHub("chat-1", "blk-1", text, AT);
    const rows = askedRows(askStore().doc());
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.words)).toContain("Please look at the marble backup job schedule.");
    expect(rows.map((row) => row.words)).toContain("Please write up the quartz search changes.");
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
