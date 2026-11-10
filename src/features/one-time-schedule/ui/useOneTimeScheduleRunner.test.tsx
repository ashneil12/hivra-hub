// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SchedulesPausedError,
  createMemoryOneTimeStore,
  type OneTimeScheduleStore,
} from "../model/oneTimeSchedule";
import { useOneTimeScheduleRunner } from "./useOneTimeScheduleRunner";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pastRow(runAt: number): string {
  return JSON.stringify([
    {
      id: "sched-1",
      target: { kind: "chat", sessionId: "chat-1" },
      prompt: "Check the build",
      runAt,
      status: "scheduled",
      createdAt: runAt - 1000,
      updatedAt: runAt - 1000,
    },
  ]);
}

function Probe({
  store,
  paused,
  submit,
}: {
  store: OneTimeScheduleStore;
  paused: () => boolean;
  submit: (sessionId: string, prompt: string) => Promise<boolean>;
}) {
  const { notices } = useOneTimeScheduleRunner({
    store,
    paused,
    sessions: () => [{ id: "chat-1", busy: false }],
    projectPaths: () => ["/work/demo"],
    createChat: () => "new-chat",
    submit,
  });
  return <p>{notices.map((notice) => notice.text).join("\n")}</p>;
}

describe("useOneTimeScheduleRunner", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.useRealTimers();
  });

  function render(node: ReactNode) {
    act(() => root?.unmount());
    host?.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(node));
  }

  async function settle() {
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it("tells about a run the closed app missed, and does not send it", async () => {
    const submit = vi.fn(async () => true);
    const store = createMemoryOneTimeStore(pastRow(Date.now() - 60_000));
    render(createElement(Probe, { store, paused: () => false, submit }));
    await settle();
    expect(host.textContent).toContain("Hivra was closed");
    expect(submit).not.toHaveBeenCalled();
    expect((await store.list())[0]?.status).toBe("missed");
  });

  it("fires a run that becomes due while the app is open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 9, 0, 0));
    const submit = vi.fn(async () => true);
    const store = createMemoryOneTimeStore();
    await store.create(
      {
        id: "sched-1",
        target: { kind: "chat", sessionId: "chat-1" },
        prompt: "Check the build",
        localText: "2026-11-09T09:02",
      },
      Date.now(),
    );
    render(createElement(Probe, { store, paused: () => false, submit }));
    await settle();
    expect(submit).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 10, 9, 9, 2, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("chat-1", "Check the build");
    expect((await store.list())[0]?.status).toBe("fired");
  });

  it("does not fire while this copy is paused, and stops after a paused claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 9, 0, 0));
    const submit = vi.fn(async () => true);
    const held = createMemoryOneTimeStore();
    await held.create(
      {
        id: "sched-1",
        target: { kind: "chat", sessionId: "chat-1" },
        prompt: "Check the build",
        localText: "2026-11-09T09:02",
      },
      Date.now(),
    );
    render(createElement(Probe, { store: held, paused: () => true, submit }));
    await settle();
    vi.setSystemTime(new Date(2026, 10, 9, 9, 2, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(submit).not.toHaveBeenCalled();
    expect((await held.list())[0]?.status).toBe("scheduled");

    vi.setSystemTime(new Date(2026, 10, 9, 9, 0, 0));
    const blocked = createMemoryOneTimeStore();
    await blocked.create(
      {
        id: "sched-2",
        target: { kind: "chat", sessionId: "chat-1" },
        prompt: "Open the notes",
        localText: "2026-11-09T09:02",
      },
      Date.now(),
    );
    let claims = 0;
    blocked.claim = async () => {
      claims += 1;
      throw new SchedulesPausedError();
    };
    render(createElement(Probe, { store: blocked, paused: () => false, submit }));
    await settle();
    vi.setSystemTime(new Date(2026, 10, 9, 9, 2, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(claims).toBe(1);
    expect(submit).not.toHaveBeenCalled();
    expect((await blocked.list())[0]?.status).toBe("scheduled");
  });
});
