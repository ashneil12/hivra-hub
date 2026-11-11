import { expect, it } from "vitest";
import { askedAgo, needChatId, needPlace, shownNeed } from "./needContext";
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

it("a row nobody's chat is behind has no reply box", () => {
  expect(needChatId(item({ open: { where: "page", id: "p1" } }), mono)).toBeUndefined();
  expect(needChatId(item({ monoId: "gone" }), mono)).toBeUndefined();
});

it("the card's Open button names where it goes, and a decision that lives in the Inbox has none", () => {
  expect(needPlace(item({ open: { where: "chat", id: "c1" }, projectId: "exo" }))).toEqual({ label: "Open chat", target: { kind: "chat", id: "c1", projectId: "exo" } });
  expect(needPlace(item({ kind: "approval", open: { where: "page", id: "p1" } }))).toEqual({ label: "Open the page", target: { kind: "page", id: "p1" } });
  expect(needPlace(item({ decisionKey: "ship" }))).toBeUndefined();
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
