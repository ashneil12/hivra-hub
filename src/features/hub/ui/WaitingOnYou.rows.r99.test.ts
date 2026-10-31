// @vitest-environment happy-dom
// r99 (Critiquito 3): a card with several decisions shows one row each, with its own answer; taking one row's pick
// leaves the other rows on the card.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { noteChats, resetWaitingChats, setWaitingChatsHost } from "../model/waitingChats";
import { WaitingOnYou } from "./WaitingOnYou";

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const notes: string[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetWaitingChats();
  notes.length = 0;
  setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => undefined, send: async () => true, open: () => undefined, note: async (_id, m) => (notes.push(m.text), true) });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

it("one row per decision, each answered on its own", async () => {
  noteChats([
    {
      id: "lead-1",
      cwd: "/tmp/tally",
      title: "Tally lead",
      harness: "claude",
      blocks: [
        { role: "user", text: "go", startedAt: 1 },
        {
          role: "assistant",
          text: "Needs Ash: Publish the privacy page now, or wait for your wording?\nMy pick: Wait for my wording.\n\nNeeds Ash: Keep the beta price, or move to the new one?\nMy pick: Keep the beta price.",
        },
      ],
    } as never,
  ]);
  act(() => root.render(createElement(WaitingOnYou, { projectId: undefined })));
  const rows = () => [...el.querySelectorAll("[data-hub-waiting-row]")];
  expect(rows().map((r) => r.querySelector("[data-hub-waiting-question]")?.textContent)).toEqual([
    "Publish the privacy page now, or wait for your wording?",
    "Keep the beta price, or move to the new one?",
  ]);
  // Each row has its own answer: the red-line one (publishing) its own Approve once / Deny, the other its pick.
  expect(rows()[0]!.querySelector("[data-hub-approve-once]")).not.toBeNull();
  expect(rows()[1]!.querySelector("[data-hub-take-pick]")).not.toBeNull();
  expect(rows().every((r) => r.querySelector("[data-hub-waiting-reply]"))).toBe(true);
  await act(async () => (rows()[1]!.querySelector("[data-hub-take-pick]") as HTMLButtonElement).click());
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain('answered your question "Keep the beta price, or move to the new one?"');
  // The other decision is still on the card, as a plain one-question card now.
  expect(el.querySelector("[data-hub-waiting-question]")?.textContent).toBe("Publish the privacy page now, or wait for your wording?");
  expect(el.querySelector("[data-hub-waiting-sent]")).toBeNull();
});
