// @vitest-environment happy-dom
// WP-182: the card's command list is the same slash catalog the composer uses.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addMono } from "../model/mono";

const mocks = vi.hoisted(() => ({
  acquireHarnessBridge: vi.fn(),
  close: vi.fn(),
  frames: [] as Array<(record: Record<string, unknown>) => void>,
  killChild: vi.fn(),
  pushLine: vi.fn(),
  releaseBridge: vi.fn(),
  request: vi.fn(),
  resolveBinary: vi.fn(),
  resolveOmpBinary: vi.fn(),
  spawnChild: vi.fn(),
  unwatchChild: vi.fn(),
  watchChild: vi.fn(),
  writeChild: vi.fn(),
}));

vi.mock("../../../integrations/harness/core/child", () => ({
  acquireHarnessBridge: mocks.acquireHarnessBridge,
  killChild: mocks.killChild,
  resolveOmpBinary: mocks.resolveOmpBinary,
  resolvePiBinary: mocks.resolveBinary,
  spawnChild: mocks.spawnChild,
  unwatchChild: mocks.unwatchChild,
  watchChild: mocks.watchChild,
  writeChild: mocks.writeChild,
}));

vi.mock("../../../integrations/harness/providers/pi/piClient", () => ({
  PiRpc: class {
    pushLine = mocks.pushLine;
    request = mocks.request;
    close = mocks.close;

    constructor(
      _sessionId: string,
      onFrame: (record: Record<string, unknown>) => void,
    ) {
      mocks.frames.push(onFrame);
    }
  },
}));

const { ensurePiRegistered } = await import("../../../integrations/harness/providers/pi/piAdapter");
const { invalidateSkills } = await import("../../skills/model/skills");
const { MonoCard } = await import("./MonoCard");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  invalidateSkills();
  for (const value of Object.values(mocks)) {
    if (typeof value === "function" && "mockReset" in value) value.mockReset();
  }
  mocks.frames.length = 0;
  mocks.acquireHarnessBridge.mockResolvedValue(mocks.releaseBridge);
  mocks.resolveBinary.mockResolvedValue({ path: "/bin/pi" });
  mocks.resolveOmpBinary.mockResolvedValue({ path: "/bin/omp" });
  mocks.spawnChild.mockResolvedValue(undefined);
  mocks.killChild.mockResolvedValue(undefined);
  mocks.writeChild.mockResolvedValue(undefined);
  mocks.request.mockResolvedValue({
    data: {
      commands: [{ name: "skill:ship", source: "skill", description: "Ship the branch" }],
    },
  });
  mocks.watchChild.mockImplementation(() => undefined);
  ensurePiRegistered();
  addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  invalidateSkills();
  vi.unstubAllGlobals();
});

it("offers a Pi slash command from the composer catalog, with no injected offers", async () => {
  await act(async () => {
    root.render(
      createElement(MonoCard, {
        monoId: "ada",
        cwd: "/work/hivra",
        harness: "pi",
        model: "pi:default",
        modelSettings: {},
        onModelChange: () => undefined,
        onModelSettingsChange: () => undefined,
      }),
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-mono-card-section="skills"]')!.click();
  });
  await act(async () => {
    await vi.waitFor(() => {
      if (!container.querySelector('[aria-label="Commands ship"]')) throw new Error("command not offered");
    });
  });
  expect(container.querySelector('[aria-label="Commands ship"]')).not.toBeNull();
});
