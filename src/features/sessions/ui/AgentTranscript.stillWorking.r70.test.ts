// @vitest-environment happy-dom
// r70 (Critiquito): a Lead's still-running note reads "Still working on <task>" in the body font, not as grey
// monospace "Still running: 1 (…)". Old saved notes read the new way too.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";
import { STILL_RUNNING_CLASS, stillRunningText } from "../../monos/model/leadFlow";

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

const render = (text: string) =>
  act(() =>
    root.render(
      createElement(AgentTranscript, {
        blocks: [
          { id: "u", role: "user", text: "ship it" },
          { id: "a", role: "assistant", text: "All done." },
          { id: "s", role: "system", notice: "still-running", text } as Block,
        ],
        busy: false,
        inlineWork: true,
        bottomAligned: true,
        hideTurnMetrics: true,
      }),
    ),
  );

describe("r70 (b): Still working on <task>", () => {
  it("renders in the body font, never a grey <pre>", () => {
    render("Still working on Tidy the inbox list. Their reports come back here when they finish.");
    const line = container.querySelector<HTMLElement>("[data-still-running]")!;
    expect(line).not.toBeNull();
    expect(line.tagName).not.toBe("PRE");
    expect(line.closest("pre")).toBeNull();
    expect(line.className).toContain("font-sans");
    expect(line.className).not.toMatch(/font-mono|text-content\/50/);
    expect(line.textContent).toMatch(/^Still working on Tidy the inbox list\./);
  });

  it("an old saved note loses the 'Still running: 1 (…)' wording", () => {
    render('Still running: 1 (Tidy the inbox list). "Ship it" stays open until they report back.');
    const text = container.querySelector("[data-still-running]")!.textContent!;
    expect(text).toBe('Still working on Tidy the inbox list. "Ship it" stays open until they report back.');
    expect(container.textContent).not.toMatch(/Still running:/);
  });

  it("the class and the rewrite on their own", () => {
    expect(STILL_RUNNING_CLASS).toContain("font-sans");
    expect(stillRunningText("Still running: 2 (API, UI). Not finished: 1 (UI).")).toBe("Still working on API, UI. Not finished: 1 (UI).");
    expect(stillRunningText("Something else")).toBe("Something else");
  });
});
