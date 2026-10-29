// @vitest-environment happy-dom
// r76 (Critiquito): the Inbox card for "which of those two?" shows the two, so Ash can answer from the card; the
// question and each option start with a capital letter. The same row is the card on Being built.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { noteChats, resetWaitingChats, setWaitingChatsHost } from "../model/waitingChats";
import { WaitingOnYou } from "./WaitingOnYou";

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetWaitingChats();
  setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => undefined, send: async () => true, open: () => undefined });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

it("shows the options the ask points back to, capitalised", () => {
  noteChats([
    {
      id: "lead-1",
      cwd: "/tmp/tally",
      title: "Tally lead",
      harness: "claude",
      blocks: [
        { role: "user", text: "go", startedAt: 1 },
        { role: "assistant", text: "Until you pick: everyone sees everyone's tallies, or tallies stay private unless shared.\n\nNeeds the user: which of those two?\nMy pick: private unless shared." },
      ],
    } as never,
  ]);
  act(() => root.render(createElement(WaitingOnYou, { projectId: undefined })));
  expect(el.querySelector("[data-hub-waiting-question]")?.textContent).toBe("Which of those two?");
  const options = [...el.querySelectorAll("[data-hub-waiting-option]")].map((o) => o.lastElementChild?.textContent);
  expect(options).toEqual(["Everyone sees everyone's tallies", "Tallies stay private unless shared"]);
});
