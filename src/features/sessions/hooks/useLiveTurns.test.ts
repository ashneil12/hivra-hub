// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_TURNS_EVENT } from "../model/liveTurns";
import { useLiveTurns } from "./useLiveTurns";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

let root: Root;
let container: HTMLDivElement;
let latest: ReadonlySet<string> = new Set();
const listeners = new Map<string, (payload: { sessionIds: string[] }) => void>();

function Harness({ local }: { local: ReadonlySet<string> }) {
  latest = useLiveTurns(local);
  return null;
}

async function mount(local: ReadonlySet<string>) {
  await act(async () => {
    root.render(createElement(Harness, { local }));
  });
}

describe("useLiveTurns", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    latest = new Set();
    listeners.clear();
    invoke.mockReset();
    listen.mockReset();
    invoke.mockImplementation(async (command: string, args?: { sessionIds?: string[] }) => {
      if (command === "live_turns_list") return ["lead"];
      if (command === "live_turns_set") {
        return [...new Set([...(args?.sessionIds ?? []), "lead"])];
      }
      return [];
    });
    listen.mockImplementation(
      async (event: string, handler: (event: { payload: { sessionIds: string[] } }) => void) => {
        listeners.set(event, (payload) => handler({ payload }));
        return () => listeners.delete(event);
      },
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("reads the process union on mount so a new window already knows", async () => {
    await mount(new Set());
    await act(async () => undefined);
    expect(invoke).toHaveBeenCalledWith("live_turns_list");
    expect(latest).toEqual(new Set(["lead"]));
  });

  it("publishes this window's busy chats and follows the event", async () => {
    await mount(new Set(["local"]));
    await act(async () => undefined);
    expect(invoke).toHaveBeenCalledWith("live_turns_set", {
      sessionIds: ["local"],
    });
    expect(latest).toEqual(new Set(["local", "lead"]));

    await act(async () => {
      listeners.get(LIVE_TURNS_EVENT)?.({ sessionIds: ["lead"] });
    });
    expect(latest).toEqual(new Set(["local", "lead"]));

    await act(async () => {
      listeners.get(LIVE_TURNS_EVENT)?.({ sessionIds: [] });
    });
    expect(latest).toEqual(new Set(["local"]));
  });
});
