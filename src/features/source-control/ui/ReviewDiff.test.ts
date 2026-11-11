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

// The split view's package loads on demand, so the split view arrives a moment after
// Split is chosen. The unified review stays on screen until then.
async function waitForSplit() {
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.querySelector("[aria-label='Split diff']")).not.toBeNull(),
    );
  });
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
  await waitForSplit();
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
  await waitForSplit();
  expect(container.textContent).not.toContain("view only");
});

it("remembers split, and follows another window", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  await render();
  await waitForSplit();
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

// A pull request review only has a patch: hunks without the full file. A split
// view drawn from hunks alone would start every file at line 1 and hide the rest.
const patchOnly = { ...file, beforeText: undefined, afterText: undefined };

function splitRadio(): Element | undefined {
  return [...container.querySelectorAll("[role='radio']")].find(
    (node) => node.textContent === "Split",
  );
}

it("offers no Split when the review only has a patch, and stays unified", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  await render({ files: [patchOnly] });
  expect(splitRadio()).toBeUndefined();
  expect(container.querySelector("[role='radiogroup']")).toBeNull();
  expect(container.querySelector("[aria-label='Unified diff']")).not.toBeNull();
  expect(container.querySelector("[aria-label='Split diff']")).toBeNull();
  expect(container.textContent).not.toContain("Split is view only");
  // The person's choice is for reviews that can split. A patch does not erase it.
  expect(localStorage.getItem(DIFF_PRESENTATION_KEY)).toBe("split");
});

it("offers no Split when one file in the review only has a patch", async () => {
  await render({
    files: [file, { ...patchOnly, id: "b.ts", path: "src/b.ts", label: "src/b.ts" }],
  });
  expect(splitRadio()).toBeUndefined();
  expect(container.querySelector("[aria-label='Unified diff']")).not.toBeNull();
});

it("still stages a hunk on a patch-only review", async () => {
  const { onStageHunk } = await render({ files: [patchOnly] });
  await act(async () => button("Stage hunk").click());
  expect(onStageHunk).toHaveBeenCalledTimes(1);
});

it("offers Split and the saved choice again on the next review that has full text", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  await render({ files: [patchOnly] });
  expect(container.querySelector("[aria-label='Split diff']")).toBeNull();
  await render({ files: [file] });
  expect(splitRadio()).toBeDefined();
  await waitForSplit();
  expect(button("Split").getAttribute("aria-checked")).toBe("true");
});

it("keeps offering Split while a file is still loading", async () => {
  await render({
    files: [
      {
        ...file,
        id: "load.ts",
        blocks: [],
        beforeText: undefined,
        afterText: undefined,
        emptyMessage: "Loading…",
      },
      file,
    ],
  });
  expect(splitRadio()).toBeDefined();
});

// Opening a file from the changes list brings it to the top of the diff. The
// split view keeps that, the way the unified view does.
const fileB = {
  ...file,
  id: "b.ts",
  path: "/repo/src/b.ts",
  label: "src/b.ts",
};
const fileA = { ...file, id: "a.ts", path: "/repo/src/a.ts" };

/** Where each file starts inside the split view's content, in pixels. */
type Offsets = Record<string, number>;

/**
 * happy-dom has no layout. This gives every file wrapper a position that
 * follows the region's scrollTop, the way a browser would report it.
 */
function stubLayout(offsets: Offsets, regionTop = 100) {
  return vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const id = this.getAttribute("data-split-file");
      const holder = this.closest("[aria-label='Split diff']");
      const top =
        id != null && holder
          ? regionTop + (offsets[id] ?? 0) - holder.scrollTop
          : this.getAttribute("aria-label") === "Split diff"
            ? regionTop
            : 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect;
    });
}

function region(): HTMLElement {
  const found = container.querySelector<HTMLElement>("[aria-label='Split diff']");
  if (!found) throw new Error("missing split region");
  return found;
}

it("scrolls the split view to the focused file by id", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  const layout = stubLayout({ "a.ts": 0, "b.ts": 380 });
  try {
    await render({ files: [fileA, fileB], focusId: "b.ts" });
    await waitForSplit();
    expect(region().scrollTop).toBe(380);
  } finally {
    layout.mockRestore();
  }
});

it("scrolls the split view to the focused file by path", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  const layout = stubLayout({ "a.ts": 0, "b.ts": 380 });
  try {
    await render({ files: [fileA, fileB], focusPath: "/repo/src/b.ts" });
    await waitForSplit();
    expect(region().scrollTop).toBe(380);
  } finally {
    layout.mockRestore();
  }
});

it("follows a new focus while staying on split", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  const layout = stubLayout({ "a.ts": 0, "b.ts": 380 });
  try {
    await render({ files: [fileA, fileB], focusId: "b.ts" });
    await waitForSplit();
    expect(region().scrollTop).toBe(380);
    await render({ files: [fileA, fileB], focusId: "a.ts" });
    expect(region().scrollTop).toBe(0);
  } finally {
    layout.mockRestore();
  }
});

it("brings the focused file up when the person switches from unified to split", async () => {
  const layout = stubLayout({ "a.ts": 0, "b.ts": 380 });
  try {
    await render({ files: [fileA, fileB], focusId: "b.ts" });
    expect(container.querySelector("[aria-label='Split diff']")).toBeNull();
    await act(async () => button("Split").click());
    await waitForSplit();
    expect(region().scrollTop).toBe(380);
  } finally {
    layout.mockRestore();
  }
});

it("leaves the split view where it is when nothing is focused", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  const layout = stubLayout({ "a.ts": 0, "b.ts": 380 });
  try {
    await render({ files: [fileA, fileB] });
    await waitForSplit();
    expect(region().scrollTop).toBe(0);
    await render({ files: [fileA, fileB], focusPath: "/repo/src/missing.ts" });
    expect(region().scrollTop).toBe(0);
  } finally {
    layout.mockRestore();
  }
});

it("keeps the focused file at the top while the diff settles, until the person scrolls", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  const resized: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const offsets: Offsets = { "a.ts": 0, "b.ts": 380 };
  const layout = stubLayout(offsets);
  try {
    await render({ files: [fileA, fileB], focusId: "b.ts" });
    await waitForSplit();
    expect(region().scrollTop).toBe(380);

    // A file above finishes drawing and pushes the focused one down.
    offsets["b.ts"] = 600;
    resized.forEach((callback) => callback());
    expect(region().scrollTop).toBe(600);

    // Once the person scrolls, the view stops chasing the focused file.
    await act(async () => {
      region().dispatchEvent(new Event("wheel"));
    });
    offsets["b.ts"] = 800;
    resized.forEach((callback) => callback());
    expect(region().scrollTop).toBe(600);
  } finally {
    layout.mockRestore();
  }
});

it("scrolls the page to the focused file when the review does not fill its pane", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  const scrolled: Array<string | null> = [];
  const spy = vi
    .spyOn(Element.prototype, "scrollIntoView")
    .mockImplementation(function (this: Element) {
      scrolled.push(this.getAttribute("data-split-file"));
    });
  try {
    await render({ files: [fileA, fileB], focusId: "b.ts", fill: false });
    await waitForSplit();
    expect(scrolled).toEqual(["b.ts"]);
  } finally {
    spy.mockRestore();
  }
});
