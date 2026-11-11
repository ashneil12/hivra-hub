// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { noteCodingTeamChat, resetCodingTeamChats } from "../../hub/model/codingTeam";
import { setHubDataSource } from "../../hub/model/hubData";
import type { HubDataSource, HubProject } from "../../hub/model/types";
import type { Session } from "../../sessions/model/session";
import { SessionStateContext, SessionStateStore } from "../../sessions/model/sessionStateStore";
import { setAgentsBoardSessionStop } from "../model/sessionStop";
import { AgentsBoardScreen } from "./AgentsBoardScreen";

const KEY = "monocode:coding-team-chats";

function project(): HubProject {
  return { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "code", folder: "/tmp/hivra" };
}

function chat(): Session {
  return {
    id: "chat-1",
    title: "Example chat",
    busy: true,
    blocks: [],
    harness: "claude",
    model: "test",
    modelSettings: {},
    runtimeMode: "supervised",
    cwd: "/tmp/hivra",
  } as Session;
}

function Host({ store }: { store: SessionStateStore }) {
  useEffect(() => setAgentsBoardSessionStop(() => undefined), []);
  return createElement(SessionStateContext.Provider, { value: store }, createElement(AgentsBoardScreen));
}

it("offers Stop on a working chat once the board has mounted", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setHubDataSource({ listProjects: () => [project()] } as unknown as HubDataSource);
  noteCodingTeamChat("chat-1", "hivra");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const store = new SessionStateStore([chat()]);
  try {
    act(() => {
      root.render(createElement(Host, { store }));
    });
    const row = container.querySelector("[data-node='chat-1']");
    if (!(row instanceof HTMLElement)) throw new Error("no row");
    act(() => row.click());
    const stop = [...container.querySelectorAll("button")].some((button) => button.textContent === "Stop");
    expect(stop).toBe(true);
    expect(container.textContent).not.toContain("Read only");
  } finally {
    act(() => root.unmount());
    container.remove();
    setAgentsBoardSessionStop(null);
    setHubDataSource(undefined);
    localStorage.removeItem(KEY);
    resetCodingTeamChats();
    vi.unstubAllGlobals();
  }
});
