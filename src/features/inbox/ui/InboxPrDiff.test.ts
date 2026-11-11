// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DIFF_PRESENTATION_KEY } from "../../source-control/model/diffPresentation";
import type { GithubPrDiff } from "../model/githubTasks";

vi.mock("../../files/editor/syntaxTokens", () => ({
  highlightDiffFile: vi.fn(() => Promise.resolve(null)),
}));

import { InboxPrDiff } from "./InboxPrDiff";

// A pull request arrives as a patch: the changed hunks, not the whole files.
const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -40,3 +40,3 @@ export function run() {",
  "   keep",
  "-  old line",
  "+  new line",
  "   keep",
  "",
].join("\n");

const diff: GithubPrDiff = {
  additions: 1,
  deletions: 1,
  files: [{ path: "src/app.ts", additions: 1, deletions: 1 }],
  patch,
  truncated: false,
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

it("shows a pull request diff unified, with no Split to choose", async () => {
  await act(async () => root.render(createElement(InboxPrDiff, { diff })));
  expect(container.querySelector("[aria-label='Unified diff']")).not.toBeNull();
  expect(container.textContent).toContain("new line");
  expect(container.querySelector("[role='radiogroup']")).toBeNull();
  expect(container.textContent).not.toContain("Split");
});

it("keeps a pull request unified when Split was chosen on another review", async () => {
  localStorage.setItem(DIFF_PRESENTATION_KEY, "split");
  await act(async () => root.render(createElement(InboxPrDiff, { diff })));
  expect(container.querySelector("[aria-label='Unified diff']")).not.toBeNull();
  expect(container.querySelector("[aria-label='Split diff']")).toBeNull();
  expect(container.querySelector("[role='radiogroup']")).toBeNull();
  expect(localStorage.getItem(DIFF_PRESENTATION_KEY)).toBe("split");
});
