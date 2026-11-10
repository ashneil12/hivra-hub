// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ both: false }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: (command: string, args?: { path?: string }) => {
      if (command === "home_dir") return Promise.resolve("C:/Users/test");
      const path = String(args?.path ?? "");
      if (command === "list_dir") {
        if (path.endsWith("/.claude/skills")) {
          return Promise.resolve([{ name: "review-only", isDir: true, path, ignored: false }]);
        }
        if (state.both && path.endsWith("/.codex/skills")) {
          return Promise.resolve([{ name: "review-only", isDir: true, path, ignored: false }]);
        }
        return Promise.resolve([]);
      }
      if (command === "read_text_file") {
        if (path.endsWith("/SKILL.md")) return Promise.resolve("---\nname: review-only\n---\n");
        return Promise.resolve(null);
      }
      return original.invoke(command, args);
    },
  };
});

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({
    branches: { current: "main", detached: false, branches: [] },
    settled: true,
  }),
}));

import { Composer } from "./Composer";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.both = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderComposer(extra: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      createElement(Composer, {
        focused: true,
        harness: "claude",
        model: "claude-sonnet",
        runtimeMode: "supervised",
        executionCwd: "C:/repo",
        hideProjectPicker: true,
        hideBranchPicker: true,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit: () => {},
        ...extra,
      }),
    );
  });
}

const handoff = { from: "claude" as const, to: "codex" as const, brief: "Recap of the thread." };
const warning = "This will not be visible to Codex: review-only.";

describe("composer skill switch warning", () => {
  it("says what a handoff will drop", async () => {
    await renderComposer({ handoffCard: handoff });
    expect(container.textContent).toContain("Handoff");
    expect(container.textContent).toContain(warning);
    expect(container.textContent).not.toMatch(/[—–]/);
  });

  it("says what a mid-thread switch will drop", async () => {
    await renderComposer({ switchFrom: "claude", switchTo: "codex" });
    expect(container.textContent).toContain(warning);
  });

  it("says a handoff and the same switch once", async () => {
    await renderComposer({
      handoffCard: handoff,
      switchFrom: "claude",
      switchTo: "codex",
    });
    const matches = container.textContent?.match(/This will not be visible to Codex: review-only\./g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("says nothing when everything travels", async () => {
    state.both = true;
    await renderComposer({ handoffCard: handoff });
    expect(container.textContent).toContain("Handoff");
    expect(container.querySelector("[data-skill-switch-notice]")).toBeNull();
  });
});
