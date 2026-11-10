// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, Session } from "../model/session";
import * as lineage from "../model/subagentLineage";
import { SessionPane, type SessionPaneProps } from "./SessionPane";

const runs: never[] = [];
vi.mock("./Composer", () => ({ Composer: () => null }));
// The pane hands the transcript the list; the transcript draws it (AgentTranscript.lineage.test.ts). The stand-in
// draws the same list from what it was handed, so this file checks what the pane reads and when.
vi.mock("./AgentTranscript", async () => {
  const { createElement: h } = await import("react");
  const { LineageList } = await import("./LineageList");
  return {
    AgentTranscript: ({ lineage }: { lineage?: lineage.Lineage | null }) =>
      lineage ? h(LineageList, { lineage }) : null,
  };
});
vi.mock("../model/subagentLineage", async (original) => {
  const real = await original<typeof import("../model/subagentLineage")>();
  return { ...real, lineageForThread: vi.fn(real.lineageForThread) };
});
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

const agentBlock: Block = {
  id: "b1",
  role: "tool",
  text: "Explore the auth module",
  tool: { callId: "toolu_agent", title: "Explore the auth module", kind: "agent", status: "completed", detail: "Auth lives in src/auth." },
  agentRun: { name: "Explore the auth module", model: "claude-haiku-5", steps: [] },
};

describe("the subagent list on the parent thread (render cost)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(lineage.lineageForThread).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function props(session: Session, extra: Record<string, unknown> = {}): SessionPaneProps {
    const noop = () => {};
    return {
      session,
      visible: true,
      focused: true,
      inSplit: false,
      composerFocused: false,
      recents: [],
      onFocus: noop, onClose: noop, onCwdChange: noop, onBranchChange: noop, onWorkspaceModeChange: noop,
      onWorktreeBaseChange: noop, onModelChange: noop, onModelSettingsChange: noop, onRuntimeModeChange: noop,
      onSubmit: noop, onSaveDraft: noop, onRemoveDraft: noop, onStop: noop, onCompactContext: () => false,
      onPlaceSessionInFolder: noop, onDeleteQueuedMessage: noop, onEditQueuedMessage: noop,
      onQueuedMessageEditingChange: noop, onSteerQueuedMessage: noop, onResumeQueue: noop, onUsageLimitResume: noop,
      onUsageLimitResumeAtReset: noop, onUsageLimitDismiss: noop, onApproval: noop, onQuestionReply: noop,
      onOpenFile: noop, onOpenDiff: noop, onOpenPlan: noop, onBuildPlan: noop, onNewTerminal: noop,
      layout: { type: "leaf", id: "chat" }, onSplit: noop,
      ...extra,
    } as SessionPaneProps;
  }

  const session: Session = {
    id: "chat", title: "Chat", cwd: "/repo", harness: "claude", model: "", modelSettings: {},
    runtimeMode: "supervised", blocks: [agentBlock],
  };

  const spy = () => vi.mocked(lineage.lineageForThread);

  it("shows each native child on the parent thread, read off the agent rows it holds", () => {
    act(() => root.render(createElement(SessionPane, props(session))));
    expect(container.querySelector("[data-lineage-summary]")?.textContent).toBe("1 done");
    act(() => container.querySelector<HTMLElement>("[data-lineage-toggle]")!.click());
    const row = container.querySelector("[data-lineage-child='toolu_agent']")!;
    expect(row.querySelector("[data-lineage-name]")?.textContent).toBe("Explore the auth module");
    expect(row.querySelector("[data-lineage-model]")?.textContent).toBe("claude-haiku-5");
    expect(row.querySelector("[data-lineage-status]")?.textContent).toBe("Done");
    expect(row.querySelector("[data-lineage-outcome='result']")?.textContent).toBe("Auth lives in src/auth.");
    expect(container.textContent).not.toContain("Open the transcript");
  });

  it("does not rebuild the list when the parent renders again with the same thread", () => {
    // The workspace renders the pane again on any change, handing it new callbacks and a new session object.
    for (let i = 0; i < 3; i++) {
      act(() =>
        root.render(
          createElement(
            SessionPane,
            props({ ...session, busy: i % 2 === 0, title: `Chat ${i}` }, { onApproval: () => {}, onSubmit: () => {} }),
          ),
        ),
      );
    }
    expect(container.querySelector("[data-lineage-summary]")?.textContent).toBe("1 done");
    expect(spy()).toHaveBeenCalledTimes(1);
  });

  it("reads the list again when the blocks change, and only then", () => {
    act(() => root.render(createElement(SessionPane, props(session))));
    const running: Session = {
      ...session,
      blocks: [{ ...agentBlock, tool: { ...agentBlock.tool!, status: "in_progress", detail: undefined } }],
    };
    act(() => root.render(createElement(SessionPane, props(running))));
    expect(spy()).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-lineage-summary]")?.textContent).toBe("1 working");
    act(() => root.render(createElement(SessionPane, props(running, { focused: false }))));
    expect(spy()).toHaveBeenCalledTimes(2);
  });

  it("labels a CLI that does not report children, and shows nothing when no agent ran", () => {
    act(() => root.render(createElement(SessionPane, props({ ...session, harness: "gemini" }))));
    expect(container.querySelector("[data-lineage-unreported]")?.textContent).toBe("Not reported by this CLI");
    expect(container.querySelector("[data-lineage-child]")).toBeNull();
    act(() => root.render(createElement(SessionPane, props({ ...session, blocks: [] }))));
    expect(container.querySelector("[data-lineage]")).toBeNull();
  });
});
