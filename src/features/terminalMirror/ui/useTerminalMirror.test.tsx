// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => {
  const invoke = vi.fn();
  let onChanged = () => {};
  return {
    invoke,
    emitChanged: () => onChanged(),
    listen: (_event: string, cb: () => void) => {
      onChanged = cb;
      return Promise.resolve(() => undefined);
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: hooks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: hooks.listen }));

import { useTerminalMirror } from "./useTerminalMirror";

const listed = [{ id: "s", title: "Notes", folder: "/work/notes", state: "running", blocks: [], updatedAt: 1 }];

function Probe() {
  const mirror = useTerminalMirror();
  useEffect(() => {
    (window as unknown as { __mirror?: typeof mirror }).__mirror = mirror;
  });
  return (
    <p>
      {mirror.sessions.map((session) => session.id).join(",")}
      <span>{mirror.note ?? ""}</span>
    </p>
  );
}

describe("the terminal list", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    hooks.invoke.mockReset();
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

  it("keeps the sessions it already has when a later read fails", async () => {
    let resolveList: (value: unknown) => void = () => undefined;
    hooks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_mirror_list") {
        return new Promise((resolve) => {
          resolveList = resolve;
        });
      }
      return Promise.resolve(null);
    });
    await act(async () => {
      root.render(createElement(Probe));
    });
    await act(async () => {
      resolveList(listed);
    });
    expect(container.textContent).toContain("s");
    hooks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_mirror_list") return Promise.reject(new Error("down"));
      return Promise.resolve(null);
    });
    await act(async () => {
      hooks.emitChanged();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("s");
  });

  it("does not send a stop the terminal cannot take", async () => {
    hooks.invoke.mockImplementation((command: string) => {
      if (command === "terminal_mirror_list") return Promise.resolve(listed);
      return Promise.resolve(null);
    });
    await act(async () => {
      root.render(createElement(Probe));
    });
    await act(async () => {
      await Promise.resolve();
    });
    type Mirror = { openSession: (id: string) => boolean; stop: () => void };
    const read = () => (window as unknown as { __mirror?: Mirror }).__mirror;
    await act(async () => {
      read()?.openSession("terminal:s");
    });
    await act(async () => {
      read()?.stop();
    });
    const stops = hooks.invoke.mock.calls.filter((call) => call[0] === "terminal_mirror_steer");
    expect(stops).toEqual([]);
    expect(container.textContent).toContain("Stopping the turn isn't available from here.");
  });
});
