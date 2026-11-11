// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DIFF_PRESENTATION_KEY } from "../model/diffPresentation";
import { buildUnifiedFile } from "../model/unifiedDiff";

// If the split package cannot be loaded (a failed download, a missing chunk), the
// review stays on the unified view it was already showing, and says so. A later
// try loads it again. The factory fails on the first import only.
const pierre = vi.hoisted(() => ({ attempts: 0 }));

vi.mock("../../files/editor/syntaxTokens", () => ({
  highlightDiffFile: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("./pierreDiff", async () => {
  const { createElement: h } = await import("react");
  pierre.attempts += 1;
  if (pierre.attempts === 1) throw new Error("Failed to fetch the split package");
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
  canStageHunk: true,
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

function radio(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("[role='radio']")].find(
    (node) => node.textContent === name,
  );
  if (!found) throw new Error(`missing ${name}`);
  return found as HTMLButtonElement;
}

it("keeps the unified review when the split package cannot load, and tries again later", async () => {
  const onStageHunk = vi.fn();
  await act(async () =>
    root.render(createElement(ReviewDiff, { files: [file], onStageHunk })),
  );
  await act(async () => radio("Split").click());
  await until(() => container.textContent?.includes("could not load") ?? false);

  expect(pierre.attempts).toBe(1);
  expect(container.textContent).toContain("Split view could not load. Showing Unified.");
  expect(container.querySelector("[aria-label='Unified diff']")).not.toBeNull();
  expect(container.querySelector("[aria-label='Split diff']")).toBeNull();
  // Unified is on screen, so staging works and nothing claims the view is read only.
  expect(container.textContent).not.toContain("Split is view only");
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((node) => node.getAttribute("aria-label") === "Stage hunk")
      ?.click();
  });
  expect(onStageHunk).toHaveBeenCalledTimes(1);

  // Choosing Unified and then Split again asks for the package again.
  await act(async () => radio("Unified").click());
  expect(container.textContent).not.toContain("could not load");
  await act(async () => radio("Split").click());
  await until(() => container.querySelector("[data-pierre-split]") !== null);
  expect(pierre.attempts).toBe(2);
  expect(container.querySelector("[aria-label='Unified diff']")).toBeNull();
  expect(container.textContent).not.toContain("could not load");
});
