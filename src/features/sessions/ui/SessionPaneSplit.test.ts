// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_SIZE, type LayoutNode } from "../../workspace/model/layout";
import { SPLIT_COLUMN_FULL } from "../../workspace/model/paneSplit";
import { SessionPane, type SessionPaneProps } from "./SessionPane";

const runs: never[] = [];
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("./AgentTranscript", () => ({ AgentTranscript: () => null }));
vi.mock("../../orchestration/model/orchestration", async (original) => ({
  ...(await original<typeof import("../../orchestration/model/orchestration")>()),
  orchestrator: {
    subscribe: () => () => {},
    snapshot: () => runs,
    hydrate: async () => {},
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

function fullestGroup(): number {
  let count = 1;
  while (1 / (count + 1) >= MIN_SIZE) count += 1;
  return count;
}

function column(count: number): LayoutNode {
  return {
    type: "split",
    id: "group",
    dir: "down",
    children: Array.from({ length: count }, (_, index) => ({
      type: "leaf" as const,
      id: index === 0 ? "chat" : `p${index}`,
    })),
    sizes: Array.from({ length: count }, () => 1 / count),
  };
}

describe("session pane split buttons", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function props(extra: Partial<SessionPaneProps> = {}): SessionPaneProps {
    const noop = () => {};
    return {
      session: {
        id: "chat",
        title: "Chat",
        cwd: "/repo",
        harness: "codex",
        model: "",
        modelSettings: {},
        runtimeMode: "supervised",
        blocks: [],
      },
      visible: true,
      focused: true,
      inSplit: false,
      composerFocused: false,
      recents: [],
      onFocus: noop,
      onClose: noop,
      onCwdChange: noop,
      onBranchChange: noop,
      onWorkspaceModeChange: noop,
      onWorktreeBaseChange: noop,
      onModelChange: noop,
      onModelSettingsChange: noop,
      onRuntimeModeChange: noop,
      onSubmit: noop,
      onSaveDraft: noop,
      onRemoveDraft: noop,
      onStop: noop,
      onCompactContext: () => false,
      onPlaceSessionInFolder: noop,
      onDeleteQueuedMessage: noop,
      onEditQueuedMessage: noop,
      onQueuedMessageEditingChange: noop,
      onSteerQueuedMessage: noop,
      onResumeQueue: noop,
      onUsageLimitResume: noop,
      onUsageLimitResumeAtReset: noop,
      onUsageLimitDismiss: noop,
      onApproval: noop,
      onQuestionReply: noop,
      onOpenFile: noop,
      onOpenDiff: noop,
      onOpenPlan: noop,
      onBuildPlan: noop,
      onNewTerminal: noop,
      layout: { type: "leaf", id: "chat" },
      onSplit: noop,
      ...extra,
    };
  }

  function render(pane: SessionPaneProps) {
    act(() => root.render(createElement(SessionPane, pane)));
  }

  function button(name: string) {
    return container.querySelector<HTMLButtonElement>(`[data-pane-split="${name}"]`);
  }

  it("shows both buttons on the header when the chat is the only pane", () => {
    render(props());
    const header = container.querySelector("[data-pane-header]");
    expect(header).not.toBeNull();
    expect(container.querySelector("[data-split-header]")).toBeNull();
    expect(header?.querySelector("[data-pane-split='right']")).not.toBeNull();
    expect(header?.querySelector("[data-pane-split='down']")).not.toBeNull();
    expect(button("right")?.disabled).toBe(false);
  });

  it("keeps a lone chat bare when nothing can split it", () => {
    render(props({ onSplit: undefined }));
    expect(container.querySelector("[data-pane-header]")).toBeNull();
    expect(container.querySelector("[data-pane-splits]")).toBeNull();
  });

  it("puts the buttons on the split header and leaves a drag off them", () => {
    const onPaneDragStart = vi.fn();
    const onSplit = vi.fn();
    const onFocus = vi.fn();
    render(
      props({
        inSplit: true,
        layout: {
          type: "split",
          id: "group",
          dir: "right",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", id: "chat" },
            { type: "leaf", id: "other" },
          ],
        },
        onPaneDragStart,
        onSplit,
        onFocus,
      }),
    );
    const header = container.querySelector("[data-split-header]");
    expect(header?.querySelector("[data-pane-split='down']")).not.toBeNull();
    expect(container.querySelector("[data-pane-header]")).toBeNull();
    act(() =>
      button("right")?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      ),
    );
    expect(onPaneDragStart).not.toHaveBeenCalled();
    act(() => button("right")?.click());
    expect(onFocus).toHaveBeenCalledWith("chat", "pointer");
    expect(onSplit).toHaveBeenCalledWith("right");
  });

  it("disables split down when the column cannot take another pane", () => {
    const onSplit = vi.fn();
    render(props({ inSplit: true, layout: column(fullestGroup()), onSplit }));
    expect(button("down")?.disabled).toBe(true);
    expect(button("down")?.title).toBe(SPLIT_COLUMN_FULL);
    expect(button("right")?.disabled).toBe(false);
    act(() => button("down")?.click());
    expect(onSplit).not.toHaveBeenCalled();
  });
});
