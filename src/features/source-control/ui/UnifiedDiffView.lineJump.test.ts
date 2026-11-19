// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../files/editor/syntaxTokens", () => ({
  highlightDiffFile: vi.fn(() => Promise.resolve(null)),
}));

import { buildUnifiedFile } from "../model/unifiedDiff";
import { ReviewDocumentBuilder } from "../model/unifiedDiffDocument";
import { lineRowIndex, UnifiedDiffView } from "./UnifiedDiffView";

const before = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
const after = before.map((text, i) => (i === 9 || i === 44 ? `${text} changed` : text));
const diff = buildUnifiedFile(before.join("\n"), after.join("\n"));
const files = ["a.ts", "b.ts"].map((id) => ({
  id,
  path: `src/${id}`,
  label: id,
  additions: diff.additions,
  deletions: diff.deletions,
  blocks: diff.blocks,
}));

describe("lineRowIndex", () => {
  const document = new ReviewDocumentBuilder().build(files, new Set(["b.ts"]), false, true);
  const rowAt = (index: number | undefined) => (index == null ? null : document.rows[index]);

  it("finds the first shown line at or after the one asked for, in that file only", () => {
    const row = rowAt(lineRowIndex(document, "b.ts", 45));
    expect(row?.fileId).toBe("b.ts");
    expect(row?.type === "line" && (row.line.newNumber ?? row.line.oldNumber)).toBe(45);
  });

  it("falls back to the file's last shown line, and to its header when it shows none", () => {
    const last = rowAt(lineRowIndex(document, "b.ts", 10_000));
    expect(last?.type).toBe("line");
    expect(last?.fileId).toBe("b.ts");
    // a.ts is folded: only its header row exists.
    expect(rowAt(lineRowIndex(document, "a.ts", 10))?.type).toBe("file");
    expect(lineRowIndex(document, "missing.ts", 1)).toBeUndefined();
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens a folded file when a guide stop jumps to one of its lines", async () => {
  const render = (focusLine?: { path: string; line: number; seq: number }) =>
    act(async () =>
      root.render(createElement(UnifiedDiffView, { files, focusLine, initialExpansion: "first" })),
    );
  const expanded = () =>
    [...container.querySelectorAll("[aria-expanded]")].map((toggle) => toggle.getAttribute("aria-expanded"));
  await render();
  expect(expanded()).toEqual(["true", "false"]);
  await render({ path: "src/b.ts", line: 45, seq: 1 });
  expect(expanded()).toEqual(["true", "true"]);
});
