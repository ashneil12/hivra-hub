// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_SIZE, type LayoutNode } from "../model/layout";
import { SPLIT_ROW_FULL } from "../model/paneSplit";
import { PaneSplitButtons } from "./PaneSplitButtons";

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

describe("PaneSplitButtons", () => {
  let container: HTMLDivElement;
  let root: Root;

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

  function render(layout: LayoutNode, onFocus = vi.fn(), onSplit = vi.fn()) {
    act(() =>
      root.render(
        createElement(
          "div",
          {
            onClick: () => onFocus("parent"),
            onMouseDown: () => onFocus("parent-down"),
          },
          createElement(PaneSplitButtons, {
            layout,
            paneId: "pane",
            onFocus,
            onSplit,
          }),
        ),
      ),
    );
    return { onFocus, onSplit };
  }

  function button(name: string) {
    return container.querySelector<HTMLButtonElement>(`[data-pane-split="${name}"]`)!;
  }

  it("focuses the pane and then calls the split handler", () => {
    const alone: LayoutNode = { type: "leaf", id: "pane" };
    const { onFocus, onSplit } = render(alone);
    expect(button("right").disabled).toBe(false);
    expect(button("down").disabled).toBe(false);
    expect(button("right").title).toBe("Split right");
    expect(button("down").getAttribute("aria-label")).toBe("Split down");

    act(() => button("right").click());
    act(() => button("down").click());

    expect(onSplit.mock.calls.map((call) => call[0])).toEqual(["right", "down"]);
    expect(onFocus.mock.calls.map((call) => call[0])).toEqual(["pane", "pane"]);
    const order: string[] = [];
    onFocus.mockImplementation(() => order.push("focus"));
    onSplit.mockImplementation(() => order.push("split"));
    act(() => button("right").click());
    expect(order).toEqual(["focus", "split"]);
  });

  it("does not let the click or the press reach the pane behind the button", () => {
    const { onFocus } = render({ type: "leaf", id: "pane" });
    onFocus.mockClear();
    act(() =>
      button("right").dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      ),
    );
    expect(onFocus).not.toHaveBeenCalled();
    act(() => button("right").click());
    expect(onFocus.mock.calls.map((call) => call[0])).toEqual(["pane"]);
  });

  it("disables the direction a full group cannot take, and says why", () => {
    const { onFocus, onSplit } = render(row(fullestGroup()));
    const right = button("right");
    const down = button("down");
    expect(right.disabled).toBe(true);
    expect(right.title).toBe(SPLIT_ROW_FULL);
    expect(right.getAttribute("aria-label")).toBe(`Split right. ${SPLIT_ROW_FULL}`);
    expect(down.disabled).toBe(false);

    act(() => right.click());
    expect(onSplit).not.toHaveBeenCalled();
    expect(onFocus).not.toHaveBeenCalled();

    act(() => down.click());
    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(onSplit).toHaveBeenCalledWith("down");
    expect(onFocus).toHaveBeenCalledWith("pane", "pointer");
  });

  it("stops calling a direction once a later layout can no longer take it", () => {
    const onFocus = vi.fn();
    const onSplit = vi.fn();
    render(row(2), onFocus, onSplit);
    act(() => button("right").click());
    expect(onSplit).toHaveBeenCalledTimes(1);

    act(() =>
      root.render(
        createElement(PaneSplitButtons, {
          layout: row(fullestGroup()),
          paneId: "pane",
          onFocus,
          onSplit,
        }),
      ),
    );
    act(() => button("right").click());
    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(button("down").disabled).toBe(false);
  });
});
