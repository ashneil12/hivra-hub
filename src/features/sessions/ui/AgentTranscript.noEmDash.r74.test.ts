// @vitest-environment happy-dom
// r74 (CoS, after the r72 blind p01/p02 grades): a coding-team reply shows without em dashes, swapped in the app like
// room posts are, so the ~1 KB hub note stays as it is. Code in the reply keeps its dashes; Copy matches what shows.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTranscript } from "./AgentTranscript";
import { turnCopyText } from "../model/transcriptActivity";
import type { Block } from "../model/session";

vi.mock("../../settings/model/sounds", () => ({ playCue: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
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

const reply = "I won't rotate the Resend key — you do that in Resend. Then run `echo a — b` to check.";
const blocks: Block[] = [
  { id: "u", role: "user", text: "can u get it rotated" },
  { id: "a", role: "assistant", text: reply },
];

describe("r74: coding-team replies show no em dashes", () => {
  it("the shown reply has a comma where the em dash was, and inline code keeps its own", () => {
    act(() =>
      root.render(createElement(AgentTranscript, { blocks, busy: false, inlineWork: true, bottomAligned: true, hideTurnMetrics: true })),
    );
    const shown = container.querySelector<HTMLElement>('[data-chat-message-role="assistant"]')!;
    expect(shown).not.toBeNull();
    expect(shown.textContent).toContain("I won't rotate the Resend key, you do that in Resend.");
    expect(shown.querySelector("code")?.textContent).toBe("echo a — b");
    expect(shown.textContent!.replace("echo a — b", "")).not.toContain("—");
  });

  it("Copy gives the same words", () => {
    expect(turnCopyText(blocks)).toBe("I won't rotate the Resend key, you do that in Resend. Then run `echo a — b` to check.");
  });
});
