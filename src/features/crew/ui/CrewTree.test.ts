// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../sessions/model/session";
import { SessionStateContext, SessionStateStore } from "../../sessions/model/sessionStateStore";
import { crewTree, type CrewTree as CrewTreeModel } from "../model/crewTree";
import type { CrewWorkerInput } from "../model/rows";
import { CrewTab } from "./CrewTab";
import { useCrewSessions } from "./useCrewSessions";

const NOW = 1_700_000_000_000;
const PROJECT = "/work/proj";

function worker(id: string, patch: Partial<CrewWorkerInput> = {}): CrewWorkerInput {
  return {
    id,
    project: PROJECT,
    title: id,
    status: "working",
    createdAt: 1,
    updatedAt: 1,
    ownerSession: "lead",
    childSession: `chat-${id}`,
    ...patch,
  };
}

function live(patch: Partial<Session> & { id: string }): Session {
  return { title: "Chat", cwd: PROJECT, blocks: [], harness: "claude", ...patch } as Session;
}

function Probe({
  store,
  workers,
  onOpenChat,
}: {
  store: SessionStateStore;
  workers: CrewWorkerInput[];
  onOpenChat: (id: string) => void;
}) {
  const extra = workers.flatMap((row) => [row.ownerSession, row.childSession].filter((id): id is string => !!id));
  const sessions = useCrewSessions(PROJECT, extra);
  const tree = crewTree({ project: PROJECT, workers, sessions, now: NOW });
  return createElement(CrewTab, { rows: [], tree, onOpenChat });
}

describe("crew tree view", () => {
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

  it("shows the root and two children above the rows, and the row actions stay", () => {
    const tree = crewTree({
      project: PROJECT,
      now: NOW,
      sessions: [{ id: "lead", title: "Lead", cwd: PROJECT, firstMate: true, blocks: [] }],
      workers: [worker("a", { title: "Fix the save", createdAt: 1 }), worker("b", { title: "Write the note", createdAt: 2 })],
    });
    const onOpen = vi.fn();
    const onOpenChat = vi.fn();
    act(() =>
      root.render(
        createElement(CrewTab, {
          rows: [
            {
              id: "a",
              title: "Fix the save",
              cli: null,
              model: null,
              status: "working",
              statusWord: "working",
              notice: null,
              howLong: "1 min",
              branch: null,
              additions: null,
              deletions: null,
              prUrl: null,
              prNumber: null,
              checks: null,
              sessionId: "chat-a",
              ownerSession: "lead",
              checkout: null,
              actions: ["open", "stop"],
            },
          ],
          tree,
          onOpen,
          onOpenChat,
        }),
      ),
    );
    const nodes = [...container.querySelectorAll("[data-crew-node]")].map((node) => node.getAttribute("data-crew-node"));
    expect(nodes).toEqual(["mate:lead", "a", "b"]);
    expect(container.innerHTML.indexOf("data-crew-tree")).toBeLessThan(container.innerHTML.indexOf("data-crew-row"));
    expect(container.textContent).not.toMatch(/stuck|error|running|—|–/);
    const stop = [...container.querySelectorAll("button")].find((button) => button.textContent === "Stop");
    expect(stop).toBeTruthy();
    act(() => container.querySelector("[data-crew-node='a']")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector("[data-crew-detail] [data-crew-brief]")?.textContent).toBe("No brief yet.");
    expect(container.querySelector("[data-crew-node='a'] button")).toBeNull();
    const open = [...container.querySelectorAll("[data-crew-detail] button")].find((button) => button.textContent === "Open the chat");
    act(() => open?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpenChat).toHaveBeenCalledWith("chat-a");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("picks up a tool call on a chat that is not in this folder, without a shell refresh", () => {
    const store = new SessionStateStore([
      live({ id: "lead", title: "Lead", firstMate: true, blocks: [] }),
      live({ id: "chat-a", cwd: "/tmp/the worktree", blocks: [] }),
    ]);
    const workers = [worker("a", { title: "Fix the save", brief: "Stop the crash" })];
    function Holder() {
      const [epoch, setEpoch] = useState(0);
      return createElement(
        "div",
        null,
        createElement(Probe, { store, workers, onOpenChat: () => undefined }),
        createElement("button", { type: "button", onClick: () => setEpoch(epoch + 1) }, "redraw"),
      );
    }
    act(() =>
      root.render(createElement(SessionStateContext.Provider, { value: store }, createElement(Holder))),
    );
    expect(container.querySelector("[data-latest-tool]")).toBeNull();
    act(() => {
      store.update(
        (sessions) =>
          sessions.map((session) =>
            session.id === "chat-a"
              ? {
                  ...session,
                  blocks: [
                    {
                      id: "t1",
                      role: "tool",
                      text: "Read notes",
                      tool: { kind: "read", title: "Read notes", status: "running", startedAt: NOW - 4_000 },
                    },
                  ],
                }
              : session,
          ),
        true,
      );
    });
    expect(container.querySelector("[data-crew-node='a'] [data-latest-tool]")?.textContent).toBe("Read notes");
    act(() => container.querySelector("[data-crew-node='a']")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector("[data-crew-brief]")?.textContent).toBe("Stop the crash");
    expect(container.querySelector("[data-tool-call='t1']")?.textContent).toContain("Read notes");
    expect(container.querySelector("[data-tool-call='t1']")?.textContent).toContain("working");
  });

  it("stays empty, and does not crash, when there is no crew", () => {
    const tree: CrewTreeModel = { root: null };
    act(() => root.render(createElement(CrewTab, { rows: [], tree })));
    expect(container.textContent).toContain("No one is on this yet.");
    expect(container.querySelector("[data-crew-node]")).toBeNull();
    act(() =>
      root.render(
        createElement(CrewTab, {
          rows: [],
          tree: crewTree({
            project: PROJECT,
            now: NOW,
            sessions: [{ id: "lead", title: "Lead", cwd: PROJECT, firstMate: true, blocks: [] }],
          }),
        }),
      ),
    );
    expect(container.querySelector("[data-crew-node='mate:lead']")?.textContent).toContain("Lead");
    expect(container.textContent).not.toContain("No one is on this yet.");
  });
});
