// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_SIZE, type EditorPane, type LayoutNode } from "../../workspace/model/layout";
import { SPLIT_ROW_FULL } from "../../workspace/model/paneSplit";
import { FilePane } from "./FilePane";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

function fullestGroup(): number {
  let count = 1;
  while (1 / (count + 1) >= MIN_SIZE) count += 1;
  return count;
}

function row(count: number): LayoutNode {
  return {
    type: "split",
    id: "group",
    dir: "right",
    children: Array.from({ length: count }, (_, index) => ({
      type: "leaf" as const,
      id: index === 0 ? "pane" : `p${index}`,
    })),
    sizes: Array.from({ length: count }, () => 1 / count),
  };
}

const pane: EditorPane = { id: "pane", files: [], activeFileId: "" };

describe("file pane split buttons", () => {
  let root: Root;
  let container: HTMLDivElement;

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

  function render(extra: Partial<ComponentProps<typeof FilePane>> = {}) {
    const onFocus = vi.fn();
    const onSplit = vi.fn();
    const noop = () => {};
    const props: ComponentProps<typeof FilePane> = {
      pane,
      focused: true,
      showTabs: false,
      dirtyFileIds: new Set(),
      fileErrorCounts: new Map(),
      sessions: [],
      onFocus,
      onSelectFile: noop,
      onCloseFile: noop,
      onCloseOtherFiles: noop,
      onDirtyChange: noop,
      onErrorCountChange: noop,
      onReorderFiles: noop,
      onOpenFile: noop,
      onUpdatePlan: noop,
      onBuildPlan: noop,
      layout: { type: "leaf", id: "pane" },
      onSplit,
      ...extra,
    };
    act(() => root.render(createElement(FilePane, props)));
    return { onFocus, onSplit };
  }

  function button(name: string) {
    return container.querySelector<HTMLButtonElement>(`[data-pane-split="${name}"]`);
  }

  it("gives a pane that is on its own no header bar, and keeps both buttons in its corner", () => {
    render();
    expect(container.querySelector("[data-pane-header]")).toBeNull();
    const corner = container.querySelector("[data-pane-corner]");
    expect(corner).not.toBeNull();
    expect(corner?.querySelector("[data-pane-split='right']")).not.toBeNull();
    expect(corner?.querySelector("[data-pane-split='down']")).not.toBeNull();
    expect(button("right")?.disabled).toBe(false);
    expect(button("down")?.disabled).toBe(false);
    const classes = (corner?.className ?? "").split(/\s+/);
    expect(classes).toContain("absolute");
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("group-hover/pane:opacity-100");
    expect(classes).toContain("has-[:focus-visible]:opacity-100");
    expect((container.firstElementChild?.className ?? "").split(/\s+/)).toContain("group/pane");
    expect(classes).not.toContain("border-b");
  });

  it("splits from the corner: focus the pane, then split", () => {
    const { onFocus, onSplit } = render();
    act(() => button("right")?.click());
    expect(onFocus).toHaveBeenCalledWith("pane", "pointer");
    expect(onSplit).toHaveBeenCalledWith("right");
  });

  it("hides them when the pane has no split handler", () => {
    render({ onSplit: undefined });
    expect(container.querySelector("[data-pane-splits]")).toBeNull();
    expect(container.querySelector("[data-pane-header]")).toBeNull();
    expect(container.querySelector("[data-pane-corner]")).toBeNull();
  });

  it("puts them on the tab header once the pane is in a split", () => {
    render({ showTabs: true, layout: row(2) });
    const tabs = container.querySelector("[role='tablist']");
    expect(tabs).not.toBeNull();
    expect(container.querySelector("[data-pane-header]")).toBeNull();
    expect(container.querySelector("[data-pane-corner]")).toBeNull();
    expect(tabs?.parentElement?.querySelector("[data-pane-split='right']")).not.toBeNull();
  });

  it("disables split right on a full row and still splits down", () => {
    const { onFocus, onSplit } = render({
      showTabs: true,
      layout: row(fullestGroup()),
    });
    expect(button("right")?.disabled).toBe(true);
    expect(button("right")?.title).toBe(SPLIT_ROW_FULL);
    expect(button("down")?.disabled).toBe(false);
    act(() => button("right")?.click());
    expect(onSplit).not.toHaveBeenCalled();
    act(() => button("down")?.click());
    expect(onFocus).toHaveBeenCalledWith("pane", "pointer");
    expect(onSplit).toHaveBeenCalledWith("down");
  });
});
