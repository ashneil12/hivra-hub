// @vitest-environment happy-dom
// "Ask Alfred" in Bot changes: Alfred's chat opens with "merge Nibbii lead's update" typed in, not sent, joined to
// whatever Ash had typed there, never twice; a Mono with no chat yet gets it when its chat is made.
import { beforeEach, expect, it, vi } from "vitest";
import { clearComposerDraft, getComposerDraft, setComposerDraft } from "../../sessions/model/draftCache";

const roster = new Map<string, { id: string; sessionId?: string }>();
vi.mock("./mono", () => ({ findMono: (id: string) => roster.get(id) }));
const opened: unknown[] = [];
vi.mock("../../hub/model/hubNav", () => ({ openMonoChat: (...a: unknown[]) => opened.push(a) }));
const { MONO_PREFILL_EVENT, openMonoChatWith, takeMonoPrefill } = await import("./monoPrefill");

beforeEach(() => {
  roster.clear();
  opened.length = 0;
  clearComposerDraft("s-alfred");
});

it("types the ask into Alfred's chat and opens it on his own chat", () => {
  roster.set("alfred", { id: "alfred", sessionId: "s-alfred" });
  const heard: unknown[] = [];
  const on = (e: Event) => heard.push((e as CustomEvent).detail);
  window.addEventListener(MONO_PREFILL_EVENT, on);
  openMonoChatWith("alfred", "merge Nibbii lead's update");
  window.removeEventListener(MONO_PREFILL_EVENT, on);
  expect(getComposerDraft("s-alfred")?.trim()).toBe("merge Nibbii lead's update");
  expect(opened).toEqual([["alfred"]]);
  expect(heard).toEqual([{ sessionId: "s-alfred", text: "merge Nibbii lead's update" }]);
});

it("keeps what Ash had typed, and a second click doesn't type it twice", () => {
  roster.set("alfred", { id: "alfred", sessionId: "s-alfred" });
  setComposerDraft("s-alfred", "also check frank");
  openMonoChatWith("alfred", "merge Nibbii lead's update");
  openMonoChatWith("alfred", "merge Nibbii lead's update");
  const draft = getComposerDraft("s-alfred")!;
  expect(draft.startsWith("also check frank")).toBe(true);
  expect(draft.split("merge Nibbii lead's update").length).toBe(2);
});

it("Alfred with no chat yet: the ask waits for his chat, then is typed in once", () => {
  roster.set("alfred", { id: "alfred" });
  openMonoChatWith("alfred", "merge Hivra lead's update");
  expect(opened).toEqual([["alfred"]]);
  takeMonoPrefill("alfred", "s-alfred");
  expect(getComposerDraft("s-alfred")?.trim()).toBe("merge Hivra lead's update");
  clearComposerDraft("s-alfred");
  takeMonoPrefill("alfred", "s-alfred");
  expect(getComposerDraft("s-alfred")).toBeUndefined();
});
