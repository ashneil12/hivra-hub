// @vitest-environment happy-dom
// r93 (c02 blind 8ff9, mid shot): "[MonoCode fix mismatch] From the app: ..." showed to Ash as his own bubble. An app
// note is one small neutral line in plain words, with no bracket tag; Ash's own message is still his bubble.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { appNoteLine, appNoteText } from "../model/appNote";
import { FIX_MISMATCH_PREFIX } from "../../monos/model/mismatchFixNudge";
import { LATEST_RESULT_PREFIX } from "../../monos/model/staleTestClaim";
import { START_WORKERS_PREFIX } from "../../monos/model/workerStartNudge";
import { AgentTranscript } from "./AgentTranscript";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const FIX = `${FIX_MISMATCH_PREFIX} From the app: your last reply flagged "This is still not done: \`npm test\` is 16 passed and 1 failed" and handed nothing out.`;
const STALE = `${LATEST_RESULT_PREFIX} From the app: your last reply told Ash "the median test is still red", but the newest worker result says the tests pass.`;

describe("an app note in the chat", () => {
  it("reads in plain words, never with its bracket tag; Ash's words and a brief are not notes", () => {
    expect(appNoteText(FIX)).toBe("The app asked the Lead to hand out a fix for a mismatch it found");
    expect(appNoteText(STALE)).toBe("The app pointed the Lead to a newer test result");
    expect(appNoteText(`${START_WORKERS_PREFIX} From the app: ...`)).toBe("The app asked the Lead to start the workers");
    expect(appNoteText("[MonoCode something new] From the app")).toBe("A note from the app");
    expect(appNoteText("[MonoCode brief from Chief of Staff] Do the thing")).toBeUndefined();
    expect(appNoteText("can the board show last week too")).toBeUndefined();
    expect(appNoteLine({ role: "assistant", text: FIX })).toBeUndefined();
    expect(appNoteLine({ role: "user", text: FIX, draft: true })).toBeUndefined();
  });

  it("renders as a small neutral line, not a user bubble", () => {
    const blocks: Block[] = [
      { id: "u1", role: "user", text: "is the rollover right?" },
      { id: "a1", role: "assistant", text: "This is still not done: `npm test` is 16 passed and 1 failed." },
      { id: "u2", role: "user", text: FIX },
      { id: "a2", role: "assistant", text: "Handed the fix to a worker." },
      { id: "u3", role: "user", text: STALE },
    ];
    act(() => root.render(createElement(AgentTranscript, { blocks, busy: false, layout: "chat" } as never)));
    const text = container.textContent ?? "";
    expect(text).not.toContain("[MonoCode");
    expect(text).not.toContain("From the app:");
    const notes = [...container.querySelectorAll("[data-app-note]")];
    expect(notes.map((n) => n.textContent)).toEqual([
      "The app asked the Lead to hand out a fix for a mismatch it found",
      "The app pointed the Lead to a newer test result",
    ]);
    expect(notes[0].className).toContain("text-[12px]");
    expect(text).toContain("is the rollover right?");
  });
});

it("renders a stored runner envelope as a collapsed result rather than Ash's message", () => {
  const text = "<system-notice>Background job has completed. Command timed out after 300 seconds.</system-notice>";
  act(() => root.render(createElement(AgentTranscript, { blocks: [{ id: "example-background", role: "user", text }], busy: false, layout: "chat" })));
  expect(container.querySelector('[data-background-result] summary')?.textContent).toContain("timed out");
  expect(container.querySelector('[data-chat-message="example-background"]')).toBeNull();
  expect(container.querySelector('[data-background-result]')?.hasAttribute("open")).toBe(false);
});
