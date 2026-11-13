// @vitest-environment happy-dom
// The two hub ledgers made one (sc-18), through the real hooks. useAskLedger writes every ask it hears, a lone short ask
// quietly (it is on the Chief's list, with no receipt and no nudge to the first mate), moves the old hub ledger's open rows
// in once on the first start, and never reaches into a chat that is no first mate's. useAskJobs applies the delegation
// rows to the asks they carry whenever they change, in the main window only.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { LedgerAsk } from "../../hub/model/askLedger";
import { resetDelegationStore, setDelegationRows } from "../../monos/model/delegationStore";
import type { Delegation } from "../../monos/model/delegations";
import type { Session } from "../../sessions/model/session";
import { askNudge, openAsksNote } from "../model/askNotes";
import { createAskStore, setAskStore, type AskStore } from "../model/askStore";
import { isQuiet } from "../model/asks";
import { useAskJobs } from "./useAskJobs";
import { useAskLedger, type AskLedgerOptions } from "./useAskLedger";

// The ledger began at NOW; his messages were sent after it, so the hook reads them (a message from before it is history).
const NOW = 1_800_000_000_000;
const SENT = NOW + 100_000;
const KEY = "monocode:hub-ask-ledger";

let mounted: { unmount: () => void; container: HTMLElement } | undefined;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.unmount());
    mounted.container.remove();
    mounted = undefined;
  }
  setAskStore(undefined);
  resetDelegationStore();
  vi.unstubAllGlobals();
});

const user = (id: string, text: string) => ({ id, role: "user", text, startedAt: SENT });
const chat = (id: string, ...blocks: ReturnType<typeof user>[]) => ({ id, busy: false, queuedMessages: [], blocks }) as unknown as Session;

/** Mounts the hooks on a ledger and waits until the ledger stops changing. */
async function mount(options: Partial<AskLedgerOptions> & { sessions: Session[]; disk?: ReturnType<typeof memoryDisk>; jobs?: boolean; clock?: () => number }): Promise<AskStore> {
  const store = createAskStore(options.disk ?? memoryDisk(), options.clock ?? (() => NOW));
  setAskStore(store);
  function Probe() {
    useAskLedger({ enabled: true, mateOf: () => "mate", cli: async () => "app", ...options });
    useAskJobs(options.jobs === true);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { unmount: () => root.unmount(), container };
  await act(async () => {
    root.render(createElement(Probe));
  });
  let still = 0;
  let last = "";
  for (let step = 0; step < 80 && still < 4; step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const now = JSON.stringify([store.doc().revision, store.doc().heard]);
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return store;
}

describe("a short message in a first mate's chat", () => {
  it("a lone short ask is written, quietly: on the list, no receipt, nothing owed, not in front of the first mate", async () => {
    const store = await mount({ sessions: [chat("chat-1", user("blk-1", "fix the save bug"))] });
    const [ask] = store.doc().asks;
    expect(store.doc().asks).toHaveLength(1);
    expect(ask).toMatchObject({ quote: "fix the save bug", mateId: "mate", status: "heard", quiet: true, heardBy: "rules" });
    expect(isQuiet(ask)).toBe(true);
    expect(openAsksNote(store.doc(), "mate", "app")).toBeUndefined();
    // The turn ends with a reply: the first mate is not nudged about an ask the reply answered.
    const done = { id: "chat-1", busy: false, blocks: [user("blk-1", "fix the save bug"), { id: "a1", role: "assistant", text: "Fixed it." }] } as unknown as Session;
    expect(askNudge(done, store.doc(), "mate", "app", new Set())).toBeUndefined();
  });

  it("two asks in two short sentences are written too, quietly, as two rows", async () => {
    const store = await mount({ sessions: [chat("chat-1", user("blk-1", "the footer is cramped, the save button should say when it worked\nand we said fridays for the board review right?"))] });
    expect(store.doc().asks.map((ask) => ask.quote)).toEqual(["the footer is cramped, the save button should say when it worked", "and we said fridays for the board review right?"]);
    expect(store.doc().asks.every((ask) => ask.quiet)).toBe(true);
  });

  it("a long message with asks in it is as loud as it always was: no quiet flag, so the receipt shows", async () => {
    const text = "Please fix the harbour invoice export so it stops dropping the last row. Please add a test for the lantern login screen. The weather is nice today.";
    const store = await mount({ sessions: [chat("chat-1", user("blk-1", text))] });
    expect(store.doc().asks).toHaveLength(2);
    expect(store.doc().asks.some((ask) => ask.quiet)).toBe(false);
  });

  it("chatter writes nothing", async () => {
    const store = await mount({ sessions: [chat("chat-1", user("blk-1", "thanks!"), user("blk-2", "ok"))] });
    expect(store.doc().asks).toEqual([]);
  });

  it("a chat that is no first mate's is left alone: hubRoute.ts writes its asks, not this hook", async () => {
    const store = await mount({ sessions: [chat("chat-plain", user("blk-1", "fix the save bug"))], mateOf: () => undefined });
    expect(store.doc().asks).toEqual([]);
  });
});

describe("the first start moves the old hub ledger in", () => {
  const legacy = (patch: Partial<LedgerAsk>): LedgerAsk => ({ id: "x", chatId: "chat-mate", blockId: "blk-old", title: "fix the save bug", words: "please fix the save bug on the settings page", at: SENT, status: "open", said: 1, ...patch });
  const mateOf = (id: string) => (id === "chat-mate" ? "vg-game-lead" : undefined);

  it("copies the open rows once, marked moved, leaves the old key as it was, and a second start copies nothing", async () => {
    localStorage.setItem(KEY, JSON.stringify([legacy({}), legacy({ blockId: "blk-2", words: "make the export remember the last folder", title: "export folder", chatId: "chat-plain" }), legacy({ blockId: "blk-3", status: "handled", words: "rename the heading" })]));
    const before = localStorage.getItem(KEY);
    const disk = memoryDisk();
    const first = await mount({ sessions: [], mateOf, disk });
    expect(first.doc().hubMoved).toBe(NOW);
    expect(first.doc().asks.map((ask) => [ask.quote, ask.mateId, ask.moved, ask.quiet])).toEqual([
      ["please fix the save bug on the settings page", "vg-game-lead", true, true],
      ["make the export remember the last folder", "hub.chats", true, true],
    ]);
    expect(localStorage.getItem(KEY)).toBe(before);
    await act(async () => mounted?.unmount());
    mounted?.container.remove();
    mounted = undefined;
    // The next start, a new store on the same disk: the old key is still there and is not read for rows again.
    const second = await mount({ sessions: [], mateOf, disk, clock: () => NOW + 60_000 });
    expect(second.doc().asks).toHaveLength(2);
    expect(second.doc().hubMoved).toBe(NOW);
  });

  it("a key that cannot be read is left for a start that can: nothing is marked moved, nothing is lost", async () => {
    localStorage.setItem(KEY, "{not json");
    const store = await mount({ sessions: [], mateOf });
    expect(store.doc().hubMoved).toBeUndefined();
    expect(store.doc().asks).toEqual([]);
    expect(localStorage.getItem(KEY)).toBe("{not json");
  });

  it("with nothing in the old key it still marks the move done", async () => {
    const store = await mount({ sessions: [], mateOf });
    expect(store.doc().hubMoved).toBe(NOW);
  });
});

describe("the daily check", () => {
  it("never goes to a chat for an ask the hub owns", async () => {
    const send = vi.fn();
    const disk = memoryDisk();
    // A hub ask started long ago and quiet since: a first mate would hear of it, the hub has nobody to tell.
    const seed = createAskStore(disk, () => 1_000);
    await seed.load();
    await seed.hear({ mateId: "hub.chats", sessionId: "chat-plain", blockId: "blk-1", list: { asks: [{ quote: "fix the save bug", summary: "fix the save bug", kind: "do" }], maybes: [] }, by: "rules", now: 1_000, quiet: true });
    await seed.change(seed.doc().asks[0].id, { status: "started" }, "app");
    const store = await mount({ sessions: [chat("chat-plain")], mateOf: () => undefined, disk, send });
    expect(send).not.toHaveBeenCalled();
    expect(store.doc().nudged).toEqual({});
  });
});

describe("a job's end reaches its ask through the hook", () => {
  const row = (patch: Partial<Delegation>): Delegation =>
    ({
      id: "t-1",
      ownerSession: "chat-1",
      ownerMono: "mate",
      batchId: null,
      parentId: null,
      rootId: "t-1",
      childSession: "app-mate-1",
      requestId: "app-chat-1-r1",
      generation: 1,
      project: null,
      title: "Fix the save bug",
      brief: null,
      goal: null,
      askIds: [],
      state: "running",
      errorClass: null,
      error: null,
      retryable: null,
      resetsAt: null,
      result: null,
      pendingQuestion: null,
      delivery: "pending",
      deliveryMessage: null,
      createdAt: SENT,
      updatedAt: SENT,
      settledAt: null,
      log: [],
      version: 1,
      mirroredVersion: 0,
      mirrorError: null,
      status: "working",
      ...patch,
    }) as Delegation;

  async function until(store: AskStore, done: () => boolean) {
    for (let step = 0; step < 80 && !done(); step += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    expect(done()).toBe(true);
  }

  it("started while the job works, done with its proof when it passes, in the one ledger", async () => {
    let clock = NOW;
    const text = "Please fix the harbour invoice export so it stops dropping the last row. Please add a test for the lantern login screen. The weather is nice today.";
    const store = await mount({ sessions: [chat("chat-1", user("blk-1", text))], jobs: true, clock: () => clock });
    const id = store.doc().asks[0].id;
    await act(async () => setDelegationRows([row({ askIds: [id] })]));
    await until(store, () => store.doc().asks[0].status === "started");
    expect(store.doc().asks[0]).toMatchObject({ status: "started", jobs: ["t-1"] });
    clock = NOW + 60_000;
    await act(async () => setDelegationRows([row({ askIds: [id], state: "completed", status: "done", gateVerdict: "passed", settledAt: NOW + 30_000, updatedAt: NOW + 30_000 })]));
    await until(store, () => store.doc().asks[0].status === "done");
    expect(store.doc().asks[0].proof).toBe('Job "Fix the save bug" finished, checks passed');
    // The second ask of that message, which no job carried, is as it was.
    expect(store.doc().asks[1].status).toBe("heard");
  });

  it("a failed job sends its ask back to heard with a note, and a row that carries no ask writes nothing", async () => {
    let clock = NOW;
    const text = "Please fix the harbour invoice export so it stops dropping the last row. Please add a test for the lantern login screen. The weather is nice today.";
    const store = await mount({ sessions: [chat("chat-1", user("blk-1", text))], jobs: true, clock: () => clock });
    const id = store.doc().asks[0].id;
    // Rows with no ledger id (an old Ash OS id, none at all) change nothing and write nothing.
    const revision = store.doc().revision;
    await act(async () => setDelegationRows([row({ id: "t-0", askIds: ["a_1020save01"] }), row({ id: "t-9", askIds: [] })]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(store.doc().revision).toBe(revision);
    await act(async () => setDelegationRows([row({ askIds: [id] })]));
    await until(store, () => store.doc().asks[0].status === "started");
    clock = NOW + 60_000;
    await act(async () => setDelegationRows([row({ askIds: [id], state: "failed", status: "failed", statusNotice: "The checks failed.", settledAt: NOW + 30_000, updatedAt: NOW + 30_000 })]));
    await until(store, () => store.doc().asks[0].status === "heard");
    expect(store.doc().asks[0].note).toBe('Its job failed ("Fix the save bug"): The checks failed. Back on the list.');
  });

  it("does nothing when it is not turned on (a build without the hub, or a second window)", async () => {
    const store = await mount({ sessions: [chat("chat-1", user("blk-1", "fix the save bug"))], jobs: false });
    const id = store.doc().asks[0].id;
    await act(async () => setDelegationRows([row({ askIds: [id] })]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(store.doc().asks[0].status).toBe("heard");
  });
});
