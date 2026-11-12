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
  clearComposerDraft("s-cam");
});

it("types the ask into Alfred's chat and opens it on his own chat", () => {
  roster.set("cam", { id: "cam", sessionId: "s-cam" });
  const heard: unknown[] = [];
  const on = (e: Event) => heard.push((e as CustomEvent).detail);
  window.addEventListener(MONO_PREFILL_EVENT, on);
  openMonoChatWith("cam", "merge Nibbii lead's update");
  window.removeEventListener(MONO_PREFILL_EVENT, on);
  expect(getComposerDraft("s-cam")?.trim()).toBe("merge Nibbii lead's update");
  expect(opened).toEqual([["cam", { main: true }]]);
  expect(heard).toEqual([{ sessionId: "s-cam", text: "merge Nibbii lead's update" }]);
});

it("keeps what Ash had typed, and a second click doesn't type it twice", () => {
  roster.set("cam", { id: "cam", sessionId: "s-cam" });
  setComposerDraft("s-cam", "also check ed");
  openMonoChatWith("cam", "merge Nibbii lead's update");
  openMonoChatWith("cam", "merge Nibbii lead's update");
  const draft = getComposerDraft("s-cam")!;
  expect(draft.startsWith("also check ed")).toBe(true);
  expect(draft.split("merge Nibbii lead's update").length).toBe(2);
});

it("Alfred with no chat yet: the ask waits for his chat, then is typed in once", () => {
  roster.set("cam", { id: "cam" });
  openMonoChatWith("cam", "merge Hivra lead's update");
  expect(opened).toEqual([["cam", { main: true }]]);
  takeMonoPrefill("cam", "s-cam");
  expect(getComposerDraft("s-cam")?.trim()).toBe("merge Hivra lead's update");
  clearComposerDraft("s-cam");
  takeMonoPrefill("cam", "s-cam");
  expect(getComposerDraft("s-cam")).toBeUndefined();
});
