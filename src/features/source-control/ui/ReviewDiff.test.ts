// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildUnifiedFile } from "../model/unifiedDiff";
import { DIFF_PRESENTATION_KEY } from "../model/diffPresentation";

vi.mock("../../files/editor/syntaxTokens", () => ({
  highlightDiffFile: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("./pierreDiff", () => ({
  PierreFile: ({
    file,
    theme,
  }: {
    file: { name: string; before: string; after: string };
    theme: string;
  }) =>
    createElement(
      "div",
      { "data-pierre-split": "split", "data-theme": theme },
      file.name,
      file.before,
      file.after,
    ),
}));

import { ReviewDiff } from "./ReviewDiff";

let container: HTMLDivElement;
let root: Root;
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem(DIFF_PRESENTATION_KEY);
  document.documentElement.classList.remove("theme-light");
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

async function render(extra: Record<string, unknown> = {}) {
  const onStageHunk = vi.fn();
  await act(async () =>
    root.render(
      createElement(ReviewDiff, {
        files: [file],
        onStageHunk,
        ...extra,
      }),
    ),
  );
  return { onStageHunk };
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === name || node.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`missing button ${name}`);
  return found as HTMLButtonElement;
}

it("starts on unified and still stages a hunk", async () => {
  const { onStageHunk } = await render();
  expect(container.querySelector("[aria-label='Unified diff']")).not.toBeNull();
  expect(container.querySelector("[aria-label='Split diff']")).toBeNull();
  expect(button("Unified").getAttribute("aria-checked")).toBe("true");
  const stage = button("Stage hunk");
  await act(async () => stage.click());
  expect(onStageHunk).toHaveBeenCalledTimes(1);
  expect(onStageHunk.mock.calls[0][0]).toBe("a.ts");
  expect(typeof onStageHunk.mock.calls[0][1]).toBe("number");
});

it("switches to split, says staging stays on unified, then stages after switching back", async () => {
  const { onStageHunk } = await render();
  await act(async () => button("Split").click());
  expect(container.querySelector("[aria-label='Unified diff']")).toBeNull();
  const split = container.querySelector("[aria-label='Split diff']");
  expect(split?.textContent).toContain("old");
  expect(split?.textContent).toContain("new");
  expect(split?.querySelector("[data-pierre-split]")?.getAttribute("data-pierre-split")).toBe(
    "split",
  );
  expect(split?.querySelector("[data-pierre-split]")?.getAttribute("data-theme")).toBe(
    "github-dark",
  );
  expect(container.textContent).toContain("Split is view only. Staging stays on Unified.");
  expect(container.querySelector("[aria-label='Stage hunk']")).toBeNull();

  await act(async () => button("Unified").click());
  expect(container.querySelector("[aria-label='Split diff']")).toBeNull();
  expect(container.textContent).not.toContain("Split is view only");
  await act(async () => button("Stage hunk").click());
  expect(onStageHunk).toHaveBeenCalledTimes(1);
});

it("keeps the inline comment on unified", async () => {
  await render();
  const comment = [...container.querySelectorAll("button")].find((node) =>
    node.getAttribute("aria-label")?.startsWith("Comment on line"),
  );
  expect(comment).toBeTruthy();
  await act(async () => comment!.click());
  const dialog = document.querySelector("[role='dialog']");
  expect(dialog).not.toBeNull();
  const cancel = [...document.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === "Cancel comment",
  );
  expect(cancel).toBeTruthy();
  await act(async () => cancel!.click());
  expect(document.querySelector("[role='dialog']")).toBeNull();
});

it("does not call split view only when the review cannot stage", async () => {
  await render({ onStageHunk: undefined });
  await act(async () => button("Split").click());
  expect(container.textContent).not.toContain("view only");
});

it("remembers split, and follows another window", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  await render();
  expect(container.querySelector("[aria-label='Split diff']")).not.toBeNull();

  localStorage.setItem(DIFF_PRESENTATION_KEY, "unified");
  await act(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: DIFF_PRESENTATION_KEY,
        newValue: "unified",
      }),
    );
  });
  expect(container.querySelector("[aria-label='Unified diff']")).not.toBeNull();
  expect(button("Unified").getAttribute("aria-checked")).toBe("true");
});

it("ignores an unknown stored choice and an unrelated storage key", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "tree");
  await render();
  expect(button("Unified").getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: "monocode.other", newValue: "split" }));
  });
  expect(button("Unified").getAttribute("aria-checked")).toBe("true");
});

it("shows a message instead of a split for a binary file", async () => {
  await act(async () =>
    root.render(
      createElement(ReviewDiff, {
        files: [
          {
            ...file,
            binary: true,
            emptyMessage: undefined,
            blocks: [],
          },
        ],
      }),
    ),
  );
  await act(async () => button("Split").click());
  expect(container.textContent).toContain("Binary file changed");
  expect(container.querySelector("[data-pierre-split]")).toBeNull();
});
