import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
    listeners.set(name, fn);
    return unlisten;
  },
}));

import { HubCallError, tauriHubTransport, toHubError } from "./hubTransport";

beforeEach(() => {
  invoke.mockReset();
  unlisten.mockReset();
  listeners.clear();
});

describe("the Tauri transport", () => {
  it("calls the hub plugin with only the action and the payload: no key, no URL", async () => {
    invoke.mockResolvedValue({ projects: [] });
    const out = await tauriHubTransport.call("ash-hub-projects", { include_archived: false });
    expect(out).toEqual({ projects: [] });
    expect(invoke).toHaveBeenCalledWith("plugin:hub|hub_call", { action: "ash-hub-projects", payload: { include_archived: false } });
    const args = invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["action", "payload"]);
  });

  it("turns the plugin's plain errors into HubCallError with their kind", async () => {
    invoke.mockRejectedValue({ kind: "unreachable", message: "Ash OS isn't running." });
    const error = await tauriHubTransport.call("ash-hub-needs").catch((e) => e);
    expect(error).toBeInstanceOf(HubCallError);
    expect(error.kind).toBe("unreachable");
    expect(error.isDown).toBe(true);
    invoke.mockRejectedValue({ kind: "error", message: "Unknown project: x" });
    const said = await tauriHubTransport.call("ash-hub-needs").catch((e) => e);
    expect(said).toMatchObject({ kind: "error", message: "Unknown project: x" });
    expect(said.isDown).toBe(false);
  });

  it("treats anything else (no Tauri at all, a string, a TypeError) as Ash OS not running", () => {
    for (const odd of [new TypeError("Cannot read properties of undefined (reading 'invoke')"), "boom", null, { kind: "weird", message: "x" }]) {
      const e = toHubError(odd);
      expect(e.kind).toBe("unreachable");
      expect(e.message).toBe("Ash OS isn't running.");
    }
  });

  it("opens the feed after the number it is given, passes events on, and closes it", async () => {
    invoke.mockResolvedValue(undefined);
    const events: unknown[] = [];
    const states: unknown[] = [];
    const close = tauriHubTransport.openFeed(42, { onEvent: (e) => events.push(e), onState: (s) => states.push(s) });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin:hub|hub_events_open", { after: 42 }));
    listeners.get("hub:event")!({ payload: { seq: 43, kind: "hub.need.opened", topics: ["needs"] } });
    listeners.get("hub:state")!({ payload: { connected: true, latest: 43 } });
    expect(events).toEqual([{ seq: 43, kind: "hub.need.opened", topics: ["needs"] }]);
    expect(states).toEqual([{ connected: true, latest: 43 }]);
    close();
    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith("plugin:hub|hub_events_close");
  });

  it("says the feed is down when it can't be opened", async () => {
    invoke.mockRejectedValue({ kind: "unreachable", message: "Ash OS isn't set up on this Mac." });
    const states: unknown[] = [];
    tauriHubTransport.openFeed(0, { onEvent: () => undefined, onState: (s) => states.push(s) });
    await vi.waitFor(() => expect(states).toEqual([{ connected: false, message: "Ash OS isn't set up on this Mac." }]));
  });
});
