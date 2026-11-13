// @vitest-environment happy-dom
// Known gaps in the hub ask ledger (hub/model/askLedger.ts, the "You asked" list) and the dump check that feeds and
// settles it (formal/asks/README.md, gaps H1 to H3), each as the shortest run that shows it. They pin what the code does
// TODAY; a change that fixes one fails its test here, so update the test then (and the README line). None is fixed here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";
import { extractAsks, openAsks, readAskLedger, recordAskText } from "./askLedger";
import { lookAtDumps, readDumpNotes } from "./dumpCheck";

beforeEach(() => {
  localStorage.clear();
});

describe("KNOWN GAP H1: the hub ledger keeps the newest 400 rows, open or not", () => {
  it("401 asks said, none settled: the first one is gone and nothing says so", () => {
    for (let i = 0; i < 401; i += 1) recordAskText(`chat-${i}`, `blk-${i}`, `Please fix the thing number ${i} on the settings page`, 1_800_000_000_000 + i);
    expect(readAskLedger()).toHaveLength(400);
    expect(openAsks()).toHaveLength(400);
    expect(readAskLedger().some((row) => row.blockId === "blk-0")).toBe(false);
    expect(readAskLedger().some((row) => row.blockId === "blk-400")).toBe(true);
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
