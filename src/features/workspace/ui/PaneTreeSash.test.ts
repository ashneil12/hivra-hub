// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorPane, LayoutNode } from "../model/layout";
import { PaneTree } from "./PaneTree";

vi.mock("../../files/ui/FilePane", async () => {
  const { createElement } = await import("react");
  return {
    FilePane: ({ pane }: { pane: EditorPane }) =>
      createElement("div", { "data-file-pane": pane.id }, pane.id),
  };
});

vi.mock("../../sessions/ui/SessionPane", () => ({ SessionPane: () => null }));

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const WIDTH = 800;
const HEIGHT = 600;

function split(
  dir: "right" | "down",
  sizes: number[],
  ids = ["a", "b"],
): LayoutNode {
  return {
    type: "split",
    id: `split-${dir}`,
    dir,
    children: ids.map((id) => ({ type: "leaf" as const, id })),
    sizes,
  };
}

function render(
  layout: LayoutNode,
  ids = ["a", "b"],
  onRatio = vi.fn(),
): { props: ComponentProps<typeof PaneTree>; onRatio: typeof onRatio } {
  const noop = vi.fn();
  const props: ComponentProps<typeof PaneTree> = {
    visible: true,
    layout,
    sessions: [],
    editorPanes: ids.map((id) => ({ id, files: [], activeFileId: "" })),
    dirtyFileIds: new Set(),
    fileErrorCounts: new Map(),
    focusedId: ids[0],
    composerFocused: false,
    recents: [],
    onFocus: noop,
    onClose: noop,
    onSelectFile: noop,
    onCloseFile: noop,
    onCloseOtherFiles: noop,
    onReorderFiles: noop,
    onFileDirtyChange: noop,
    onFileErrorCountChange: noop,
    onRatio,
    onCwdChange: noop,
    onBranchChange: noop,
    onModelChange: noop,
    onModelSettingsChange: noop,
    onRuntimeModeChange: noop,
    onSubmit: noop,
    onStop: noop,
    onCompactContext: noop,
    onPlaceSessionInFolder: noop,
    onDeleteQueuedMessage: noop,
    onEditQueuedMessage: noop,
    onQueuedMessageEditingChange: noop,
    onSteerQueuedMessage: noop,
    onResumeQueue: noop,
    onApproval: noop,
    onQuestionReply: noop,
    onOpenFile: noop,
    onOpenDiff: noop,
    onOpenPlan: noop,
    onUpdatePlan: noop,
    onBuildPlan: noop,
    onMovePane: noop,
    onDetachPane: noop,
    onNewTerminal: noop,
  };
  act(() => root.render(createElement(PaneTree, props)));
  const tree = container.firstElementChild as HTMLElement;
  tree.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: WIDTH,
      height: HEIGHT,
      right: WIDTH,
      bottom: HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return { props, onRatio };
}

const separator = () =>
  container.querySelector<HTMLElement>('[role="separator"]')!;
const handle = () => separator().firstElementChild as HTMLElement;
const guideShown = () => separator().hasAttribute("data-snapped");

function dragHandle(
  handle: HTMLElement,
  from: number,
  to: { x: number; y: number },
  options: { altKey?: boolean; release?: boolean } = {},
) {
  const captured = new Set<number>();
  handle.setPointerCapture = (id) => captured.add(id);
  handle.hasPointerCapture = (id) => captured.has(id);
  handle.releasePointerCapture = (id) => captured.delete(id);
  act(() =>
    handle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: from,
        clientY: HEIGHT / 2,
      }),
    ),
  );
  act(() =>
    handle.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: to.x,
        clientY: to.y,
        altKey: options.altKey ?? false,
      }),
    ),
  );
  if (options.release !== false)
    act(() =>
      handle.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: to.x,
          clientY: to.y,
        }),
      ),
    );
}

function keydown(target: HTMLElement, key: string, shiftKey = false) {
  act(() =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

describe("pane divider snapping", () => {
  it("commits a plain drag outside every snap spot", () => {
    const { onRatio } = render(split("right", [0.5, 0.5]));
    // 100 px right of the middle, far from 2/3 (33 px away).
    dragHandle(handle(), 400, { x: 500, y: 300 });
    expect(onRatio).toHaveBeenCalledTimes(1);
    const [splitId, index, ratio] = onRatio.mock.calls[0];
    expect(splitId).toBe("split-right");
    expect(index).toBe(0);
    expect(ratio).toBeCloseTo(0.625);
    expect(guideShown()).toBe(false);
  });

  it("settles on 1/2 when the pointer comes within 12 pixels", () => {
    const { onRatio } = render(split("right", [0.5, 0.5]));
    dragHandle(handle(), 400, { x: 407, y: 300 });
    expect(onRatio.mock.calls[0][2]).toBeCloseTo(0.5);
  });

  it("shows a guide line only while a snap is active", () => {
    render(split("right", [0.5, 0.5]));
    const knob = handle();
    const captured = new Set<number>();
    knob.setPointerCapture = (id) => captured.add(id);
    knob.hasPointerCapture = (id) => captured.has(id);
    act(() =>
      knob.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: 400,
          clientY: 300,
        }),
      ),
    );
    const move = (x: number) =>
      act(() =>
        knob.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            button: 0,
            pointerId: 1,
            clientX: x,
            clientY: 300,
          }),
        ),
      );
    move(407);
    expect(guideShown()).toBe(true);
    move(520);
    expect(guideShown()).toBe(false);
    move(410);
    expect(guideShown()).toBe(true);
    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(guideShown()).toBe(false);
  });

  it("settles on a quarter or three quarters in a wide group", () => {
    const quarter = render(split("right", [0.5, 0.5]));
    dragHandle(handle(), 400, { x: 200 + 6, y: 300 });
    expect(quarter.onRatio.mock.calls[0][2]).toBe(0.25);
    act(() => root.unmount());
    root = createRoot(container);
    const threeQuarters = render(split("right", [0.5, 0.5]));
    dragHandle(handle(), 400, { x: 600 - 5, y: 300 });
    expect(threeQuarters.onRatio.mock.calls[0][2]).toBe(0.75);
  });

  it("uses the group's own width, not the window's", () => {
    // A nested group that is half the tree is only 400 px across, so 12 px
    // there is 3 percent of the group rather than 1.5.
    const { onRatio } = render(
      split("right", [0.5, 0.5], ["a", "b"]),
      ["a", "b"],
    );
    // The outer divider is the only one, so a 7 px move snaps on 800 px.
    dragHandle(handle(), 400, { x: 405, y: 300 });
    expect(onRatio.mock.calls[0][2]).toBe(0.5);
  });

  it("follows the pointer exactly while Alt is held", () => {
    const { onRatio } = render(split("right", [0.5, 0.5]));
    dragHandle(handle(), 400, { x: 407, y: 300 }, { altKey: true });
    expect(onRatio.mock.calls[0][2]).toBeCloseTo(407 / 800);
  });

  it("still holds the minimum pane size while Alt is held", () => {
    const { onRatio } = render(split("right", [0.5, 0.5]));
    dragHandle(handle(), 400, { x: -50, y: 300 }, { altKey: true });
    expect(onRatio.mock.calls[0][2]).toBeCloseTo(0.08);
  });

  it("snaps a vertical divider on its own axis", () => {
    const { onRatio } = render(split("down", [0.5, 0.5]));
    dragHandle(handle(), 300, { x: 400, y: 304 });
    expect(onRatio.mock.calls[0][2]).toBe(0.5);
  });

  it("evens the two panes on a double-click", () => {
    const { onRatio } = render(split("right", [0.2, 0.8]));
    act(() =>
      handle().dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, button: 0 }),
      ),
    );
    expect(onRatio).toHaveBeenCalledTimes(1);
    expect(onRatio.mock.calls[0][2]).toBe(0.5);
  });

  it("moves by 2 percent with the arrow keys, and 10 with Shift", () => {
    // A nudge commits through the parent, so the next render carries it,
    // as it does in the app. Each press below starts from its last commit.
    const sizes: number[] = [0.5, 0.5];
    const nudge = (key: string, shiftKey = false) => {
      const onRatio = vi.fn();
      render(split("right", [...sizes]), ["a", "b"], onRatio);
      keydown(separator(), key, shiftKey);
      const next = onRatio.mock.calls[0][2] as number;
      sizes[0] = next;
      sizes[1] = 1 - next;
      return next;
    };
    expect(nudge("ArrowRight")).toBeCloseTo(0.52);
    expect(nudge("ArrowLeft", true)).toBeCloseTo(0.42);
    expect(nudge("ArrowDown")).toBeCloseTo(0.44);
    expect(nudge("ArrowUp", true)).toBeCloseTo(0.34);
  });

  it("holds the arrow keys at the minimum pane size", () => {
    const { onRatio } = render(split("right", [0.1, 0.9]));
    keydown(separator(), "ArrowLeft", true);
    expect(onRatio.mock.calls[0][2]).toBeCloseTo(0.08);
  });

  it("keeps the separator's role and value in step with the drag", () => {
    render(split("right", [0.5, 0.5]));
    expect(separator().getAttribute("role")).toBe("separator");
    expect(separator().getAttribute("aria-label")).toBe("Resize panes");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
    expect(separator().getAttribute("aria-valuemin")).toBe("0");
    expect(separator().getAttribute("aria-valuemax")).toBe("100");
    expect(separator().getAttribute("aria-orientation")).toBe("vertical");
    expect(separator().tabIndex).toBe(0);

    // Mid-drag the hairline is where the pointer is, and its value says so.
    const knob = handle();
    knob.setPointerCapture = () => {};
    knob.hasPointerCapture = () => false;
    act(() =>
      knob.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: 400,
          clientY: 300,
        }),
      ),
    );
    act(() =>
      knob.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: 600,
          clientY: 300,
        }),
      ),
    );
    expect(separator().getAttribute("aria-valuenow")).toBe("75");
    expect(separator().style.left).toBe("75%");
    // Escape puts the line back where the layout still has it.
    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
    expect(separator().style.left).toBe("50%");
  });
});
