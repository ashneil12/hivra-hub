// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { WorktreeAutoClearSetting } from "./WorktreeAutoClearSetting";

const LABEL = "Clear build output of finished worktrees";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as Record<string, unknown>).__MONOCODE_APP__;
});

async function render() {
  await act(async () => {
    root.render(createElement(WorktreeAutoClearSetting));
  });
}

function box(): HTMLInputElement {
  const input = host.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("missing checkbox");
  return input;
}

it("is on before the app has answered, and when it says nothing was ever chosen", async () => {
  vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
  await render();
  const group = host.querySelector("#setting-worktree-autoclear");
  expect(group?.getAttribute("data-setting-id")).toBe("worktree-autoclear");
  expect(host.textContent).toContain(LABEL);
  expect(box().checked).toBe(true);
  expect(host.textContent).not.toMatch(/[—–]/);

  act(() => root.unmount());
  root = createRoot(host);
  vi.mocked(invoke).mockResolvedValue({ enabled: true, running: false, lastRun: null });
  await render();
  expect(invoke).toHaveBeenCalledWith("worktree_autoclean_status");
  expect(box().checked).toBe(true);
  expect(box().disabled).toBe(false);
});

it("shows the app's choice when it was turned off, and what the last check did", async () => {
  vi.mocked(invoke).mockResolvedValue({
    enabled: false,
    running: false,
    lastRun: {
      at: Date.now() - 2 * 60_000,
      tookMs: 10,
      checked: 2,
      cleared: [{ path: "/w/a", branch: "a", why: "pull request #7 merged", folders: [], bytes: 9_100_000_000 }],
      clearedBytes: 9_100_000_000,
      heldBack: 1,
      errors: [],
    },
  });
  await render();
  expect(box().checked).toBe(false);
  expect(host.textContent).toContain("Last check 2 min ago: cleared build output in 1 worktree (9.1 GB).");
});

it("saves a change through the app, and goes back when the app refuses it", async () => {
  vi.mocked(invoke).mockResolvedValue({ enabled: true, running: false, lastRun: null });
  await render();
  vi.mocked(invoke).mockResolvedValueOnce({ enabled: false, running: false, lastRun: null });
  await act(async () => box().click());
  expect(invoke).toHaveBeenLastCalledWith("worktree_autoclean_set", { enabled: false });
  expect(box().checked).toBe(false);

  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
  await act(async () => box().click());
  expect(box().checked).toBe(false);
  expect(host.textContent).toContain("disk full");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps the choice on and says why when the app can't be reached", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("no app"));
  await render();
  expect(box().checked).toBe(true);
  expect(box().disabled).toBe(false);
  expect(host.textContent).toContain("no app");
});

it("keeps the default showing when the answer is not a status", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await render();
  expect(box().checked).toBe(true);
  expect(host.textContent).not.toContain("undefined");
});

it("says a dev copy never clears anything", async () => {
  (globalThis as Record<string, unknown>).__MONOCODE_APP__ = {
    product: "MonoCode Hub Dev",
    version: "0.16.0",
    identifier: "com.ash.monocode-hub.dev.x",
    kind: "dev",
    slot: "x",
    stamp: { sha: "0123456789abcdef", branch: "b", dirty: false, builtAt: "" },
    schemaVersion: 20,
    policy: { clearBuildOutput: false },
  };
  vi.mocked(invoke).mockResolvedValue({ enabled: true, running: false, lastRun: null });
  await render();
  expect(host.textContent).toContain("This is a dev copy, so it never clears anything.");
});
