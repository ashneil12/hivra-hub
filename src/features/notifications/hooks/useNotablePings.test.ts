// @vitest-environment happy-dom
// The app's one look for a due notable ping: the real hook, the real buffer and the real quiet hours; only the native
// notification call and the window label are stand-ins.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitNotable, readNotableBuffer, saveNotableBuffer } from "../model/notableEvents";
import { saveNotificationsEnabled, setWindowFocused } from "../model/notifications";
import { saveQuietHours } from "../model/quietHours";
import { useNotablePings } from "./useNotablePings";

const { invoke, label } = vi.hoisted(() => ({ invoke: vi.fn(), label: { current: "main" } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: label.current }) }));
vi.mock("cuelume", () => ({ play: vi.fn(), setEnabled: vi.fn(), setVolume: vi.fn() }));

const banners = () => invoke.mock.calls.filter(([command]) => command === "show_notification");
const held = { id: "held:s1:1", kind: "held", text: "Fix login: Claude finished", at: 1 };

let root: Root;
let container: HTMLElement;
function Probe() {
  useNotablePings();
  return null;
}
const mount = () => act(async () => root.render(createElement(Probe)));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  label.current = "main";
  saveNotificationsEnabled(true);
  setWindowFocused(false);
  saveQuietHours({ enabled: true, start: "22:00", end: "08:00" });
  vi.useFakeTimers();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("looking for a due ping", () => {
  it("sends a notice held overnight on the first look after the window ends, and only once", async () => {
    vi.setSystemTime(new Date(2026, 10, 10, 23, 30));
    commitNotable(readNotableBuffer, saveNotableBuffer, held);
    await mount();
    expect(banners()).toEqual([]);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(banners()).toEqual([]);

    vi.setSystemTime(new Date(2026, 10, 11, 8, 0, 5));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(banners()).toHaveLength(1);
    expect(banners()[0][1]).toMatchObject({ subtitle: "While you were away", body: "Fix login: Claude finished" });
    expect(readNotableBuffer().pending).toEqual([]);

    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(banners()).toHaveLength(1);
  });

  it("sends a due ping when it mounts, and stays out of a window that is not the main one", async () => {
    vi.setSystemTime(new Date(2026, 10, 10, 12, 0));
    commitNotable(readNotableBuffer, saveNotableBuffer, { id: "red", kind: "ci-red", text: "PR #42: checks failed", at: 1 });
    label.current = "second";
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(banners()).toEqual([]);
    await act(async () => root.unmount());

    label.current = "main";
    root = createRoot(container);
    await mount();
    expect(banners()).toHaveLength(1);
    expect(banners()[0][1]).toMatchObject({ subtitle: "CI failed" });
  });
});
