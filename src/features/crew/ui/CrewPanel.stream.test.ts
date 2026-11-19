// @vitest-environment happy-dom
// The crew panel is mounted next to a chat that streams. A text-only stream update (the words of a reply arriving)
// changes nothing the crew draws, so it must not rebuild the tree or redraw the panel. A tool call, a new prompt or a
// chat going busy still does.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Delegation } from "../../monos/model/delegations";
import type { Block, Session } from "../../sessions/model/session";
import { SessionStateContext, SessionStateStore } from "../../sessions/model/sessionStateStore";
import { resetCrewFocus } from "../model/focus";
import { crewTree } from "../model/crewTree";
import { CrewPanel } from "./CrewPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../model/crewTree", async (original) => {
  const real = await original<typeof import("../model/crewTree")>();
  return { ...real, crewTree: vi.fn(real.crewTree) };
});

const PROJECT = "/work/proj";

const ROW = {
  id: "w1",
  ownerSession: "lead",
  ownerMono: null,
  batchId: null,
  parentId: null,
  rootId: "w1",
  childSession: "chat-w1",
  requestId: "w1",
  generation: 1,
  project: PROJECT,
  title: "Fix the save bug",
  brief: "Stop the crash",
  goal: null,
  askIds: [],
  state: "running",
  errorClass: null,
  error: null,
  retryable: null,
  resetsAt: null,
  result: null,
  pendingQuestion: null,
  delivery: "pending",
  deliveryMessage: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  settledAt: null,
  log: [],
  version: 1,
  mirroredVersion: 0,
  mirrorError: null,
  status: "working",
  statusNotice: null,
  questionOwner: null,
} as unknown as Delegation;

function chat(patch: Partial<Session> & { id: string }): Session {
  return { title: "Chat", cwd: PROJECT, harness: "claude", blocks: [], ...patch } as Session;
}

function words(text: string): Block {
  return { id: "reply", role: "assistant", text, streaming: true } as Block;
}

describe("the crew panel while a chat streams", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: SessionStateStore;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetCrewFocus();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "delegations_list_open" || command === "delegations_recent") return [ROW];
      return [];
    });
    store = new SessionStateStore([
      chat({
        id: "lead",
        title: "Lead",
        firstMate: true,
        busy: true,
        blocks: [
          { id: "ask", role: "user", text: "Fix the save bug" } as Block,
          words("Starting"),
        ],
      }),
      chat({
        id: "chat-w1",
        title: "Worker chat",
        cwd: "/tmp/the worktree",
        busy: true,
        blocks: [
          { id: "t1", role: "tool", text: "Read notes", tool: { kind: "read", title: "Read notes", status: "running" } } as Block,
          { id: "reply", role: "assistant", text: "Looking", streaming: true } as Block,
        ],
      }),
    ]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCrewFocus();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => {
      root.render(
        createElement(
          SessionStateContext.Provider,
          { value: store },
          createElement(CrewPanel, { project: PROJECT, sessions: [], onOpenSession: () => {} }),
        ),
      );
    });
    // The first loads settle: workers are in, and the tree has been drawn from them.
    await vi.waitFor(() => expect(container.querySelector("[data-crew-node='w1']")).toBeTruthy());
  }

  /** The words of a reply grow, the way the app delivers them: a text-only batch. */
  function stream(sessionId: string, text: string) {
    act(() => {
      store.update(
        (sessions) =>
          sessions.map((session) =>
            session.id !== sessionId
              ? session
              : {
                  ...session,
                  blocks: session.blocks.map((block) => (block.id === "reply" ? { ...block, text } : block)),
                },
          ),
        true,
      );
    });
  }

  it("does not rebuild the tree or touch the panel when only the words of a reply change", async () => {
    await mount();
    const builds = vi.mocked(crewTree).mock.calls.length;
    const node = container.querySelector("[data-crew-node='w1']");
    const rendered = container.innerHTML;
    expect(builds).toBeGreaterThan(0);

    for (let step = 1; step <= 25; step += 1) {
      stream("chat-w1", `Looking at the save code, step ${step}`);
      stream("lead", `Starting on it, step ${step}`);
    }

    expect(vi.mocked(crewTree).mock.calls.length).toBe(builds);
    expect(container.querySelector("[data-crew-node='w1']")).toBe(node);
    expect(container.innerHTML).toBe(rendered);
  });

  it("does not rebuild the tree for a render that changes nothing it draws, such as its parent drawing again", async () => {
    await mount();
    const builds = vi.mocked(crewTree).mock.calls.length;
    expect(builds).toBeGreaterThan(0);

    // The app hands the panel a new list of chat summaries and a new callback whenever any chat moves. The workers, the
    // chats the tree reads and the clock are the same, so the tree is too.
    for (let round = 0; round < 5; round += 1) {
      await act(async () => {
        root.render(
          createElement(
            SessionStateContext.Provider,
            { value: store },
            createElement(CrewPanel, { project: PROJECT, sessions: [], onOpenSession: () => {} }),
          ),
        );
      });
    }

    expect(vi.mocked(crewTree).mock.calls.length).toBe(builds);
    expect(container.querySelector("[data-crew-node='w1']")).toBeTruthy();
  });

  it("still redraws when a tool call starts on a chat the crew draws", async () => {
    await mount();
    expect(container.querySelector("[data-crew-node='w1'] [data-latest-tool]")?.textContent).toBe("Read notes");
    const builds = vi.mocked(crewTree).mock.calls.length;
    act(() => {
      store.update((sessions) =>
        sessions.map((session) =>
          session.id === "chat-w1"
            ? {
                ...session,
                blocks: [
                  { id: "t1", role: "tool", text: "Read notes", tool: { kind: "read", title: "Read notes", status: "completed" } } as Block,
                  { id: "t2", role: "tool", text: "Run the tests", tool: { kind: "execute", title: "Run the tests", status: "running" } } as Block,
                  ...session.blocks.filter((block) => block.id === "reply"),
                ],
              }
            : session,
        ),
      );
    });
    expect(vi.mocked(crewTree).mock.calls.length).toBeGreaterThan(builds);
    expect(container.querySelector("[data-crew-node='w1'] [data-latest-tool]")?.textContent).toBe("Run the tests");
  });

  it("still redraws when the first mate gets a new prompt, or a chat stops being busy", async () => {
    await mount();
    const builds = vi.mocked(crewTree).mock.calls.length;
    act(() => {
      store.update((sessions) =>
        sessions.map((session) =>
          session.id === "lead"
            ? { ...session, blocks: [...session.blocks, { id: "ask2", role: "user", text: "Now ship it" } as Block] }
            : session,
        ),
      );
    });
    expect(vi.mocked(crewTree).mock.calls.length).toBeGreaterThan(builds);
    const afterPrompt = vi.mocked(crewTree).mock.calls.length;
    act(() => {
      store.update((sessions) => sessions.map((session) => (session.id === "chat-w1" ? { ...session, busy: false } : session)));
    });
    expect(vi.mocked(crewTree).mock.calls.length).toBeGreaterThan(afterPrompt);
  });
});
