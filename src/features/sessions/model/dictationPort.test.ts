// LOW 1 (round 3): the dictation chunk listener belongs to this window. A global listen() receives every emit_to in
// the app, so a second window would get the words of another window's dictation. This test models Tauri's routing:
// a global listener receives every emitted event, and a window listener receives only the events sent to its label.
import { beforeEach, describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => {
  type Handler = (event: { payload: unknown }) => void;
  return {
    current: "main",
    noWindow: false,
    global: [] as Handler[],
    windows: new Map<string, Handler[]>(),
    emitTo(label: string, payload: unknown) {
      for (const handler of this.global) handler({ payload });
      for (const handler of this.windows.get(label) ?? []) handler({ payload });
    },
    reset() {
      this.current = "main";
      this.noWindow = false;
      this.global = [];
      this.windows = new Map();
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    bus.global.push(handler);
    return Promise.resolve(() => {
      bus.global = bus.global.filter((h) => h !== handler);
    });
  },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => {
    if (bus.noWindow) throw new Error("no current window");
    return {
      label: bus.current,
      listen: (
        _name: string,
        handler: (event: { payload: unknown }) => void,
      ) => {
        const list = bus.windows.get(bus.current) ?? [];
        list.push(handler);
        bus.windows.set(bus.current, list);
        const label = bus.current;
        return Promise.resolve(() => {
          bus.windows.set(
            label,
            (bus.windows.get(label) ?? []).filter((h) => h !== handler),
          );
        });
      },
    };
  },
}));

import { tauriDictationPort } from "./dictationPort";
import type { DictationChunk } from "./dictation";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the desktop dictation port", () => {
  beforeEach(() => {
    bus.reset();
  });

  it("a chunk sent to another window never reaches this window's listener", async () => {
    const chunks: DictationChunk[] = [];
    bus.current = "main";
    tauriDictationPort.subscribe((chunk) => chunks.push(chunk));
    await flush();

    bus.emitTo("other", {
      session: 7,
      text: "private words",
      finished: false,
      error: false,
    });
    bus.emitTo("main", {
      session: 1,
      text: "hello",
      finished: false,
      error: false,
    });

    expect(chunks).toEqual([
      { session: 1, text: "hello", finished: false, error: false },
    ]);
  });

  it("unsubscribing stops the window's listener", async () => {
    const chunks: DictationChunk[] = [];
    bus.current = "main";
    const stop = tauriDictationPort.subscribe((chunk) => chunks.push(chunk));
    await flush();
    stop();
    bus.emitTo("main", {
      session: 1,
      text: "late",
      finished: false,
      error: false,
    });
    expect(chunks).toEqual([]);
  });

  // MED (#216 follow-up): the composer subscribes on every mount. A window lookup that throws must not take the
  // composer down with it; dictation just hears nothing.
  it("a start token reaches this window and a chunk does not", async () => {
    const tokens: number[] = [];
    bus.current = "main";
    const stop = tauriDictationPort.watchStart((token) => tokens.push(token));
    await flush();
    bus.emitTo("other", { token: 9 });
    bus.emitTo("main", { session: 1, text: "hello", finished: false, error: false });
    bus.emitTo("main", { token: 4 });
    bus.emitTo("main", { token: 0 });
    bus.emitTo("main", { token: -2 });
    bus.emitTo("main", {});
    expect(tokens).toEqual([4]);
    stop();
    bus.emitTo("main", { token: 5 });
    expect(tokens).toEqual([4]);
  });

  it("a window lookup that throws does not throw out of watchStart", () => {
    bus.noWindow = true;
    let stop: (() => void) | undefined;
    expect(() => {
      stop = tauriDictationPort.watchStart(() => {});
    }).not.toThrow();
    expect(() => stop?.()).not.toThrow();
  });

  it("a window lookup that throws does not throw out of subscribe", () => {
    bus.noWindow = true;
    let stop: (() => void) | undefined;
    expect(() => {
      stop = tauriDictationPort.subscribe(() => {});
    }).not.toThrow();
    expect(() => stop?.()).not.toThrow();
  });
});
