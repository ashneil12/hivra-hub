// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteCodingTeamChat, resetCodingTeamChats } from "../../hub/model/codingTeam";
import { setHubDataSource } from "../../hub/model/hubData";
import type { HubStore } from "../../hub/model/hubStore";
import type { HubDataSource, HubProject } from "../../hub/model/types";
import type { Session } from "../../sessions/model/session";
import { SessionStateContext, SessionStateStore } from "../../sessions/model/sessionStateStore";
import { AgentsBoardScreen } from "./AgentsBoardScreen";

const KEY = "monocode:coding-team-chats";

function project(name: string): HubProject {
  return { id: "hivra", name, shortName: name.split(" ")[0] || name, iconShape: "code", folder: "/tmp/hivra" };
}

function chat(id: string, title: string): Session {
  return {
    id,
    title,
    busy: true,
    blocks: [],
    harness: "claude",
    model: "test",
    modelSettings: {},
    runtimeMode: "supervised",
    cwd: "/tmp/hivra",
  } as Session;
}

describe("Agents board keeps up with the stores it reads", () => {
  let container: HTMLDivElement;
  let root: Root;
  let name = "Hivra";
  let snap = { tick: 0 };
  const listeners = new Set<() => void>();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    name = "Hivra";
    snap = { tick: 0 };
    listeners.clear();
    const source = { listProjects: () => [project(name)] } as unknown as HubDataSource;
    const store = {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snap,
    } as unknown as HubStore;
    setHubDataSource(source, store);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setHubDataSource(undefined);
    localStorage.removeItem(KEY);
    resetCodingTeamChats();
    vi.unstubAllGlobals();
  });

  function render(sessions: Session[]) {
    const store = new SessionStateStore(sessions);
    act(() => {
      root.render(createElement(SessionStateContext.Provider, { value: store }, createElement(AgentsBoardScreen)));
    });
  }

  function publish() {
    act(() => {
      snap = { tick: snap.tick + 1 };
      for (const listener of listeners) listener();
    });
  }

  it("shows a project chat once that chat is noted, without the session list changing", () => {
    render([chat("chat-1", "Example chat")]);
    expect(container.textContent).not.toContain("Example chat");
    act(() => noteCodingTeamChat("chat-1", "hivra"));
    expect(container.textContent).toContain("Example chat");
  });

  it("shows a project's new name when hub data changes, without the session list changing", () => {
    render([]);
    expect(container.textContent).toContain("Hivra");
    name = "Example renamed";
    publish();
    expect(container.querySelector("option[value='hivra']")?.textContent).toBe("Example renamed");
  });
});
