// @vitest-environment happy-dom
// r97 (Critiquito h, c02 BLIND 242d shot 01): the app's grey line "16 passed, 0 failed: the suite is green. Test run in
// the project itself…" showed in a code font. It uses the normal UI font now, in the chat and in the work trail.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript, MonoActivityTrail } from "./AgentTranscript";

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

const NOTE = "16 passed, 0 failed: the suite is green. Test run in the project itself, by the app after the last landing.";

const check = () => {
  const line = container.querySelector<HTMLElement>("[data-app-status]");
  expect(line?.textContent).toContain("16 passed, 0 failed");
  expect(line!.closest("pre, code")).toBeNull();
  expect(line!.className).toContain("font-sans");
  expect(line!.className).not.toContain("font-mono");
};

it("the app's test line is in the UI font in the chat", () => {
  act(() =>
    root.render(
      createElement(AgentTranscript, {
        blocks: [
          { id: "u", role: "user", text: "fix the board" },
          { id: "a", role: "assistant", text: "Done." },
          { id: "s", role: "system", text: NOTE, startedAt: 2 } as Block,
        ],
        busy: false,
        bottomAligned: true,
        hideTurnMetrics: true,
      }),
    ),
  );
  check();
});

it("and in the turn's work trail", () => {
  act(() => root.render(createElement(MonoActivityTrail, { blocks: [{ id: "s", role: "system", text: NOTE, startedAt: 2 } as Block] })));
  check();
});
