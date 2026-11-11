// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { noteCodingTeamChat, resetCodingTeamChats } from "../../hub/model/codingTeam";
import { setHubDataSource } from "../../hub/model/hubData";
import type { HubDataSource, HubProject } from "../../hub/model/types";
import type { Block, Session } from "../../sessions/model/session";
import { SessionStateContext, SessionStateStore } from "../../sessions/model/sessionStateStore";
import { AgentsBoardScreen } from "./AgentsBoardScreen";

const KEY = "monocode:coding-team-chats";

function project(): HubProject {
  return { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "code", folder: "/tmp/hivra" };
}

function chat(id: string, reads: { n: number }): Session {
  const block = {
    id: `${id}-line`,
    role: "user",
    get text() {
      reads.n += 1;
      return `Example: ${id}`;
    },
  } as Block;
  return {
    id,
    title: id,
    busy: false,
    blocks: [block],
    harness: "claude",
    model: "test",
    modelSettings: {},
    runtimeMode: "local",
    cwd: "/tmp/hivra",
  } as Session;
}

afterEach(() => {
  setHubDataSource(undefined);
  localStorage.removeItem(KEY);
  resetCodingTeamChats();
  vi.unstubAllGlobals();
});

it("reads the open chat's transcript and leaves the others unread", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setHubDataSource({ listProjects: () => [project()] } as unknown as HubDataSource);
  noteCodingTeamChat("open-chat", "hivra");
  noteCodingTeamChat("other-chat", "hivra");
  const openReads = { n: 0 };
  const otherReads = { n: 0 };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const store = new SessionStateStore([chat("open-chat", openReads), chat("other-chat", otherReads)]);
  try {
    act(() => {
      root.render(createElement(SessionStateContext.Provider, { value: store }, createElement(AgentsBoardScreen)));
    });
    expect(openReads.n).toBe(0);
    expect(otherReads.n).toBe(0);
    const row = container.querySelector("[data-node='open-chat']");
    if (!(row instanceof HTMLElement)) throw new Error("no row");
    act(() => row.click());
    expect(openReads.n).toBeGreaterThan(0);
    expect(otherReads.n).toBe(0);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
