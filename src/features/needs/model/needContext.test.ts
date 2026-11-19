import { afterEach, expect, it } from "vitest";
import { setHomeOpener, type HomeOpenTarget } from "../../home/model/opener";
import { pendingTranscriptAsk, resetTranscriptJumps } from "../../sessions/model/transcriptJump";
import { askedAgo, markAsked, needChatId, needPlace, openNeed, shownNeed } from "./needContext";
import { inboxParts } from "./inboxShow";
import type { NeedsItem } from "./needsYou";

const item = (patch: Partial<NeedsItem>): NeedsItem => ({ key: "question:a", kind: "question", who: "EXO lead", at: 0, sentence: "Example: which take?", actions: [], ...patch });
const monos: Record<string, { sessionId?: string; projectSessions?: Record<string, string> }> = {
  "exo-lead": { sessionId: "lead-main" },
  chief: { sessionId: "chief-main", projectSessions: { exo: "chief-exo" } },
};
const mono = (id: string) => monos[id];

it("replies go to the chat the ask came from", () => {
  expect(needChatId(item({ open: { where: "chat", id: "worker-chat" }, monoId: "exo-lead" }), mono)).toBe("worker-chat");
});

it("a decision with no chat of its own replies to the first mate who asked, in its chat for that project", () => {
  expect(needChatId(item({ monoId: "exo-lead", projectId: "exo" }), mono)).toBe("lead-main");
  expect(needChatId(item({ monoId: "chief", projectId: "exo" }), mono)).toBe("chief-exo");
  expect(needChatId(item({ monoId: "chief", projectId: "hivra" }), mono)).toBe("chief-main");
});

it("a decision opens and replies in the chat that asked it, when that is one of the first mate's own chats", () => {
  const lead = { sessionId: "lead-main", chats: ["lead-second"] };
  expect(needChatId(item({ monoId: "exo-lead", projectId: "exo", askedBy: "lead-second" }), () => lead)).toBe("lead-second");
  expect(needChatId(item({ monoId: "exo-lead", projectId: "exo", askedBy: "a-worker-chat" }), () => lead)).toBe("lead-main");
  expect(needChatId(item({ monoId: "chief", projectId: "exo", askedBy: "chief-main" }), mono)).toBe("chief-main");
});

it("a row nobody's chat is behind has no reply box", () => {
  expect(needChatId(item({ open: { where: "page", id: "p1" } }), mono)).toBeUndefined();
  expect(needChatId(item({ monoId: "gone" }), mono)).toBeUndefined();
});

it("the card's Open button names where it goes, and a decision that lives in the Inbox has none", () => {
  expect(needPlace(item({ open: { where: "chat", id: "c1" }, projectId: "exo" }))).toEqual({ label: "Open chat", target: { kind: "chat", id: "c1", projectId: "exo" } });
  expect(needPlace(item({ kind: "approval", open: { where: "page", id: "p1" } }))).toEqual({ label: "Open the hub", target: { kind: "page", id: "p1" } });
  expect(needPlace(item({ decisionKey: "ship" }))).toBeUndefined();
});

afterEach(() => resetTranscriptJumps());

it("opening a row's chat leaves word to land on the message that asked, with when it was asked", () => {
  const opened: HomeOpenTarget[] = [];
  const off = setHomeOpener((target) => opened.push(target));
  openNeed(item({ open: { where: "chat", id: "c1" }, projectId: "exo", at: 42 }));
  off();
  expect(opened).toEqual([{ kind: "chat", id: "c1", projectId: "exo" }]);
  expect(pendingTranscriptAsk("c1")).toEqual({ text: "Example: which take?", at: 42 });
});

it("a stopped worker's chat opens on its end, and a row that leads elsewhere asks no chat for anything", () => {
  const off = setHomeOpener(() => {});
  openNeed(item({ kind: "stopped", open: { where: "chat", id: "worker" } }));
  openNeed(item({ decisionKey: "ship" }));
  off();
  expect(pendingTranscriptAsk("worker")).toBeNull();
});

it("the asking first mate's own chat is searched by the ask's words only: the ask may not be in it", () => {
  markAsked("lead-main", item({ at: 42 }), false);
  expect(pendingTranscriptAsk("lead-main")).toEqual({ text: "Example: which take?" });
});

it("says how long ago it was asked", () => {
  const now = 10 * 24 * 3_600_000;
  expect(askedAgo(now - 20_000, now)).toBe("just now");
  expect(askedAgo(now - 12 * 60_000, now)).toBe("12 min ago");
  expect(askedAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
  expect(askedAgo(now - 2 * 24 * 3_600_000, now)).toBe("2 d ago");
});

it("All shows both lists, Asks only the asks, the work items only themselves", () => {
  expect(inboxParts("all")).toEqual({ asks: true, items: true });
  expect(inboxParts("asks")).toEqual({ asks: true, items: false });
  expect(inboxParts("items")).toEqual({ asks: false, items: true });
});

it("the open card is the picked row; once it is answered, the next one only when asks alone show", () => {
  const rows = [{ key: "a" }, { key: "b" }];
  expect(shownNeed(rows, "b", false)).toEqual({ key: "b" });
  expect(shownNeed(rows, null, false)).toBeUndefined();
  expect(shownNeed(rows, null, true)).toEqual({ key: "a" });
  expect(shownNeed(rows, "gone", false)).toBeUndefined();
  expect(shownNeed(rows, "gone", true)).toEqual({ key: "a" });
  expect(shownNeed([], null, true)).toBeUndefined();
});
