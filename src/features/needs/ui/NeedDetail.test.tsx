// @vitest-environment happy-dom
// Ash, 11 Nov: an Inbox row "doesn't actually bring me to anything". A row opens its card: the ask, who and when, its
// answers, the way to its chat and a box that sends words to that chat.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setHomeOpener, type HomeOpenTarget } from "../../home/model/opener";
import { setWaitingChatsHost } from "../../hub/model/waitingChats";
import { createMono, saveMonoSessionId, saveMonoSideChat } from "../../monos/model/mono";
import type { NeedsItem } from "../model/needsYou";
import { pendingTranscriptAsk, resetTranscriptJumps } from "../../sessions/model/transcriptJump";
import { NeedDetail } from "./NeedDetail";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const HOUR = 3_600_000;
let container: HTMLDivElement;
let root: Root;
let undo: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  undo.forEach((stop) => stop());
  undo = [];
  localStorage.clear();
  vi.unstubAllGlobals();
  resetTranscriptJumps();
});

function need(patch: Partial<NeedsItem> = {}): NeedsItem {
  return {
    key: "question:take",
    kind: "question",
    who: "Example lead",
    at: 10 * HOUR,
    sentence: "Example: which take goes in the trailer?",
    actions: [],
    open: { where: "chat", id: "lead-chat" },
    ...patch,
  };
}

async function show(item: NeedsItem) {
  await act(async () => {
    root.render(createElement(NeedDetail, { item, now: 13 * HOUR }));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
}

it("shows what was asked, who asked and when", async () => {
  await show(need());
  expect(container.querySelector("[data-need-kind]")?.textContent).toBe("Question");
  expect(container.querySelector("[data-need-sentence]")?.textContent).toBe("Example: which take goes in the trailer?");
  expect(container.querySelector("[data-need-from]")?.textContent).toBe("Example lead · 3 h ago");
});

it("the row's own answer is the filled button, and Open chat leads to the chat the ask came from", async () => {
  const answered = vi.fn();
  const opened: HomeOpenTarget[] = [];
  undo.push(setHomeOpener((target) => opened.push(target)));
  await show(need({ projectId: "exo", actions: [{ label: "Take 2", run: answered }, { label: "Open chat", run: () => {} }] }));
  const answers = [...container.querySelectorAll("[data-need-answer]")];
  expect(answers.map((b) => b.textContent)).toEqual(["Take 2"]);
  expect(answers[0]?.className).toContain("bg-accent");
  await act(async () => (answers[0] as HTMLButtonElement).click());
  expect(answered).toHaveBeenCalledTimes(1);
  const open = container.querySelector("[data-need-open]") as HTMLButtonElement;
  expect(open.textContent).toBe("Open chat");
  expect(open.className).not.toContain("bg-accent");
  await act(async () => open.click());
  expect(opened).toEqual([{ kind: "chat", id: "lead-chat", projectId: "exo" }]);
});

it("a decision's Open chat opens the chat that asked it (where the reply goes too), on the message that asked", async () => {
  const lead = createMono();
  saveMonoSessionId(lead.id, "lead-main");
  saveMonoSideChat(lead.id, "lead-second");
  const opened: HomeOpenTarget[] = [];
  undo.push(setHomeOpener((target) => opened.push(target)));
  await show(need({ open: undefined, decisionKey: "take", monoId: lead.id, projectId: "exo", askedBy: "lead-second" }));
  await act(async () => (container.querySelector("[data-need-open]") as HTMLButtonElement).click());
  expect(opened).toEqual([{ kind: "chat", id: "lead-second", projectId: "exo" }]);
  expect(pendingTranscriptAsk("lead-second")).toEqual({ text: "Example: which take goes in the trailer?", at: 10 * HOUR });
});

it("Open chat lands on the message that asked: it leaves the ask's words and time for that chat", async () => {
  const opened: HomeOpenTarget[] = [];
  undo.push(setHomeOpener((target) => opened.push(target)));
  await show(need({ projectId: "exo" }));
  await act(async () => (container.querySelector("[data-need-open]") as HTMLButtonElement).click());
  expect(opened).toHaveLength(1);
  expect(pendingTranscriptAsk("lead-chat")).toEqual({ text: "Example: which take goes in the trailer?", at: 10 * HOUR });
});

it("a few words go to that chat as the person's next message", async () => {
  const sent: [string, string][] = [];
  undo.push(
    setWaitingChatsHost({
      liveQuestion: () => undefined,
      respond: () => {},
      open: () => {},
      send: async (sessionId, text) => {
        sent.push([sessionId, text]);
        return true;
      },
    }),
  );
  await show(need());
  const box = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(box.getAttribute("aria-label")).toBe("Reply to Example lead");
  expect(button("Send")?.disabled).toBe(true);
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(box, "  Use take 2, shorter.  ");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Send")?.click());
  expect(sent).toEqual([["lead-chat", "Use take 2, shorter."]]);
  expect(container.querySelector("[data-need-reply-state]")?.getAttribute("data-need-reply-state")).toBe("sent");
  expect(box.value).toBe("");
});

it("says so when the words did not send, and keeps them", async () => {
  await show(need());
  const box = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(box, "Use take 2.");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Send")?.click());
  expect(container.querySelector("[data-need-reply-state]")?.getAttribute("data-need-reply-state")).toBe("failed");
  expect(box.value).toBe("Use take 2.");
});

it("a page asking for access has no chat behind it: no reply box, and Open leads to the page", async () => {
  await show(need({ kind: "approval", open: { where: "page", id: "p1" }, who: "Example page" }));
  expect(container.querySelector("[data-need-reply]")).toBeNull();
  expect(container.querySelector("[data-need-open]")?.textContent).toBe("Open the hub");
});
