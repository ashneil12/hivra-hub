// @vitest-environment happy-dom
// Gap A7, through the live wiring: the Needs you list reads the ask ledger, and each answer on a quiet ask's row writes
// it on the revision the card was drawn for (so a card for an ask that moved since refuses and changes nothing).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setHomeOpener, type HomeOpenTarget } from "../../home/model/opener";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { setWaitingChatsHost } from "../../hub/model/waitingChats";
import { createMono, saveMonoName, saveMonoProjectSession, saveMonoSessionId } from "../../monos/model/mono";
import { pendingTranscriptAsk, resetTranscriptJumps } from "../../sessions/model/transcriptJump";
import { chaseOf, raisedAsks } from "../../asks/model/askQuiet";
import { createAskStore, setAskStore, type AskStore } from "../../asks/model/askStore";
import { needsYou } from "./needsYou";
import { factsFromParts, type NeedsParts } from "./needsLive";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 15, 12);
const ASKED = NOW - 3 * DAY;
const RAISED = NOW - HOUR;
const PROJECTS = [{ id: "exo", name: "EXO", folder: "/Users/example/Projects/exo" }];

let store: AskStore;
let mia: string;
let undo: (() => void)[] = [];

function row(over: Record<string, unknown> = {}) {
  return {
    id: "ask-4-blk4",
    n: 4,
    mateId: mia,
    sessionId: "mia-exo-chat",
    blockId: "blk4",
    quote: "Example: fix the invoice export so it stops dropping the last row",
    summary: "Fix the invoice export",
    kind: "do",
    status: "heard",
    heardBy: "model",
    createdAt: ASKED,
    updatedAt: ASKED,
    history: [{ at: ASKED, status: "heard", by: "app" }],
    chase: { at: ASKED, checks: 2, raisedAt: RAISED },
    ...over,
  };
}

beforeEach(async () => {
  localStorage.clear();
  const mate = createMono();
  mia = mate.id;
  saveMonoName(mia, "Mia");
  saveMonoSessionId(mia, "mia-main");
  saveMonoProjectSession(mia, "exo", "mia-exo-chat");
  store = createAskStore(memoryDisk({ asks: { next: 5, since: 0, heard: {}, nudged: {}, asks: [row()] } }), () => NOW);
  setAskStore(store);
  await store.load();
});

afterEach(() => {
  undo.forEach((stop) => stop());
  undo = [];
  setAskStore(undefined);
  resetTranscriptJumps();
  localStorage.clear();
});

function list() {
  const parts: NeedsParts = {
    remote: { decisions: [], cards: [], watches: [] },
    rows: [],
    projects: PROJECTS,
    chats: [],
    pages: [],
    delegations: [],
    asks: raisedAsks(store.doc()),
    now: NOW,
  };
  return needsYou(factsFromParts(parts), NOW);
}

it("a raised ask is a row of the one list, worded with its first mate and project", () => {
  const [need] = list();
  expect(need).toMatchObject({ kind: "ask", who: "Mia", projectId: "exo", monoId: mia });
  expect(need.sentence).toBe("You asked: Example: fix the invoice export so it stops dropping the last row");
  expect(need.detail).toBe("Still open since Thursday. Mia hasn't moved it.");
  expect(need.choices).toEqual(["Answer it", "Let it go", "Remind Mia"]);
});

it("an ask no daily check has raised is not a row", async () => {
  store = createAskStore(memoryDisk({ asks: { next: 5, since: 0, heard: {}, nudged: {}, asks: [row({ chase: { at: ASKED, checks: 1 } })] } }), () => NOW);
  setAskStore(store);
  await store.load();
  expect(list()).toEqual([]);
});

it("Answer it opens the chat that asked, on the message that asked", async () => {
  const opened: HomeOpenTarget[] = [];
  undo.push(setHomeOpener((target) => opened.push(target)));
  await list()[0].answer?.("Answer it");
  expect(opened).toEqual([{ kind: "chat", id: "mia-exo-chat", projectId: "exo" }]);
  expect(pendingTranscriptAsk("mia-exo-chat")).toEqual({ text: "Example: fix the invoice export so it stops dropping the last row", at: ASKED });
  // Nothing was written: the row is still there.
  expect(list()).toHaveLength(1);
});

it("Let it go is the person's own drop, and the row goes", async () => {
  expect(await list()[0].answer?.("Let it go")).toBeUndefined();
  const dropped = store.doc().asks[0];
  expect(dropped.status).toBe("dropped");
  expect(dropped.history.at(-1)?.by).toBe("ash");
  expect(list()).toEqual([]);
});

it("Let it go on a card for an ask that moved since refuses, and the ask is untouched", async () => {
  const card = list()[0];
  await store.change("ask-4-blk4", { status: "started", note: "on it" }, "mate");
  expect(await card.answer?.("Let it go")).toMatch(/moved/);
  expect(store.doc().asks[0].status).toBe("started");
  // Two windows: one lets it go, the other taps the same card a second later.
  const again = createAskStore(memoryDisk({ asks: { next: 5, since: 0, heard: {}, nudged: {}, asks: [row()] } }), () => NOW);
  setAskStore(again);
  await again.load();
  const stale = needsYou(factsFromParts({ remote: { decisions: [], cards: [], watches: [] }, rows: [], projects: PROJECTS, chats: [], pages: [], delegations: [], asks: raisedAsks(again.doc()), now: NOW }), NOW)[0];
  expect(await stale.answer?.("Let it go")).toBeUndefined();
  expect(await stale.answer?.("Let it go")).toMatch(/not on the list|moved/);
  expect(again.doc().asks[0].history.filter((step) => step.status === "dropped")).toHaveLength(1);
});

it("Remind queues one reminder, takes the row away and resets the count", async () => {
  expect(await list()[0].answer?.("Remind Mia")).toBeUndefined();
  expect(list()).toEqual([]);
  expect(chaseOf(store.doc().asks[0])).toMatchObject({ checks: 0, remindAt: NOW });
  expect(store.doc().asks[0].status).toBe("heard");
});

it("the box sends the words to the chat that asked, and that answers the ask", async () => {
  const sent: [string, string][] = [];
  undo.push(setWaitingChatsHost({ send: async (id: string, text: string) => (sent.push([id, text]), true) } as never));
  expect(await list()[0].answer?.("Do the CSV one first")).toBeUndefined();
  expect(sent).toEqual([["mia-exo-chat", "Do the CSV one first"]]);
  expect(list()).toEqual([]);
  expect(store.doc().asks[0].status).toBe("heard");
});

it("the box that cannot send says so, and keeps the row", async () => {
  undo.push(setWaitingChatsHost({ send: async () => false } as never));
  expect(await list()[0].answer?.("Do the CSV one first")).toBe("That did not send. Open the chat and say it there.");
  expect(list()).toHaveLength(1);
});

it("a status change on the ask takes the row away", async () => {
  expect(list()).toHaveLength(1);
  await store.change("ask-4-blk4", { status: "waiting", note: "needs your call" }, "mate");
  expect(list()).toEqual([]);
});
