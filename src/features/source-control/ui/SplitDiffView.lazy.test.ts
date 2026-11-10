// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DIFF_PRESENTATION_KEY } from "../model/diffPresentation";
import { buildUnifiedFile } from "../model/unifiedDiff";

// The split view's package is large and starts a highlighter. It must only load
// when a split is drawn, never with the review screen. A mock factory runs the
// first time its module is imported, so it counts when that happens. The factory
// also waits for `release`, so a test can look at the screen while the package is
// still on its way.
const pierre = vi.hoisted(() => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { loaded: 0, gate, release: () => release() };
});

vi.mock("../../files/editor/syntaxTokens", () => ({
  highlightDiffFile: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("./pierreDiff", async () => {
  const { createElement: h } = await import("react");
  pierre.loaded += 1;
  await pierre.gate;
  return { PierreFile: () => h("div", { "data-pierre-split": "split" }) };
});

import { ReviewDiff } from "./ReviewDiff";

const diff = buildUnifiedFile("kept\nold\n", "kept\nnew\n");
const file = {
  id: "a.ts",
  path: "src/a.ts",
  label: "src/a.ts",
  additions: diff.additions,
  deletions: diff.deletions,
  blocks: diff.blocks,
  beforeText: "kept\nold\n",
  afterText: "kept\nnew\n",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem(DIFF_PRESENTATION_KEY);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.removeItem(DIFF_PRESENTATION_KEY);
  vi.unstubAllGlobals();
});

// Updates from a promise that settles inside an `act` scope are held until the scope
// ends, so wait in short scopes and look again.
async function until(check: () => boolean) {
  for (let tries = 0; tries < 100 && !check(); tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(check()).toBe(true);
}

function splitRadio(): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Split",
  );
  if (!found) throw new Error("missing Split");
  return found as HTMLButtonElement;
}

it("loads the split package only when a file is drawn side by side", async () => {
  const binary = {
    ...file,
    id: "img.png",
    path: "img.png",
    label: "img.png",
    binary: true,
    blocks: [],
  };
  await act(async () =>
    root.render(createElement(ReviewDiff, { files: [binary] })),
  );
  expect(container.querySelector("[aria-label='Unified diff']")).not.toBeNull();
  expect(pierre.loaded).toBe(0);

  // A split that only has notes to show (here a binary file) needs no package.
  await act(async () => splitRadio().click());
  expect(container.querySelector("[aria-label='Split diff']")).not.toBeNull();
  expect(container.textContent).toContain("Binary file changed");
  expect(pierre.loaded).toBe(0);

  // The first text file drawn side by side brings the package in.
  const second = { ...file, id: "b.ts", path: "src/b.ts", label: "src/b.ts" };
  const layout = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const id = this.getAttribute("data-split-file");
      const region = this.closest("[aria-label='Split diff']");
      const top = id === "b.ts" && region ? 500 - region.scrollTop : 0;
      return {
        top,
        bottom: top,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: top,
      } as DOMRect;
    });
  try {
    await act(async () =>
      root.render(
        createElement(ReviewDiff, {
          files: [binary, file, second],
          focusId: "b.ts",
        }),
      ),
    );
    await until(() => pierre.loaded === 1);

    // The package is on its way. Until it arrives the unified review stays on
    // screen: no split region, no loading note in its place.
    expect(container.querySelector("[aria-label='Unified diff']")).not.toBeNull();
    expect(container.querySelector("[aria-label='Split diff']")).toBeNull();
    expect(container.querySelector("[data-pierre-split]")).toBeNull();
    expect(container.textContent).not.toContain("Loading split view");
    expect(container.textContent).not.toContain("Split is view only");

    pierre.release();
    await until(() => container.querySelector("[data-pierre-split]") !== null);
    expect(pierre.loaded).toBe(1);
    expect(container.querySelector("[aria-label='Unified diff']")).toBeNull();
    // The files were not in place until the package arrived. The focused one is
    // still brought to the top once they are.
    expect(
      container.querySelector<HTMLElement>("[aria-label='Split diff']")
        ?.scrollTop,
    ).toBe(500);
  } finally {
    layout.mockRestore();
  }
});
