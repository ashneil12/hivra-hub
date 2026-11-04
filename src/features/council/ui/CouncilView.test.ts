// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blankProposal } from "../model/record";
import { CouncilView } from "./CouncilView";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const engine = { cli: "claude", family: "Anthropic", label: "Claude Code" };

function show(model?: () => Promise<{ text: string }>) {
  act(() => {
    root.render(
      createElement(CouncilView, {
        roomId: "room",
        record: blankProposal("Should we ship?"),
        engines: [engine],
        personas: [],
        ...(model ? { model } : {}),
        onChange: () => true,
      }),
    );
  });
}

it("starts only when a model is connected", () => {
  show();
  const off = container.querySelector<HTMLButtonElement>("[data-council-confirm]");
  expect(off?.disabled).toBe(true);
  expect(container.textContent).toContain("No model is connected, so this council can't start.");

  show(async () => ({ text: "" }));
  const on = container.querySelector<HTMLButtonElement>("[data-council-confirm]");
  expect(on?.disabled).toBe(false);
  expect(container.textContent).not.toContain("No model is connected, so this council can't start.");
});
