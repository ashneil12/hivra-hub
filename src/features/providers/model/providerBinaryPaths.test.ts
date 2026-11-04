import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  loadProviderBinaryPath,
  saveProviderBinaryPath,
} from "./providerBinaryPaths";

const key = "monocode.providerBinaryPaths.v1";

beforeEach(() => {
  mocks.invoke.mockReset();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider binary paths", () => {
  it("repairs malformed storage when saving a path", () => {
    let stored = "not json";
    vi.mocked(localStorage.getItem).mockImplementation(() => stored);
    vi.mocked(localStorage.setItem).mockImplementation((_key, value) => {
      stored = value;
    });
    expect(saveProviderBinaryPath("codex", "/opt/codex")).toBe(true);
    expect(loadProviderBinaryPath("codex")).toBe("/opt/codex");
  });

  it("filters non-string paths before runtime initialization", async () => {
    const stored = JSON.stringify({ cursor: null, codex: "/opt/codex" });
    vi.mocked(localStorage.getItem).mockImplementation(() => stored);
    mocks.invoke.mockResolvedValue({ codex: "/opt/codex" });

    vi.resetModules();
    const providerPaths = await import("./providerBinaryPaths");
    await providerPaths.initializeProviderBinaryPaths();

    expect(mocks.invoke).toHaveBeenCalledWith("harness_runtime_binary_paths", {
      paths: { codex: "/opt/codex" },
    });
    expect(providerPaths.runtimeProviderBinaryPath("cursor")).toBeNull();
    expect(providerPaths.runtimeProviderBinaryPath("codex")).toBe("/opt/codex");
  });

  it("keeps the active path unchanged across windows until restart", async () => {
    let stored = JSON.stringify({ cursor: "/opt/cursor/old" });
    vi.mocked(localStorage.getItem).mockImplementation(() => stored);
    vi.mocked(localStorage.setItem).mockImplementation((_key, value) => {
      stored = value;
    });
    mocks.invoke.mockResolvedValue({ cursor: "/opt/cursor/old" });

    vi.resetModules();
    const firstWindow = await import("./providerBinaryPaths");
    await firstWindow.initializeProviderBinaryPaths();
    expect(firstWindow.runtimeProviderBinaryPath("cursor")).toBe("/opt/cursor/old");

    firstWindow.saveProviderBinaryPath("cursor", "/opt/cursor/new");
    expect(firstWindow.runtimeProviderBinaryPath("cursor")).toBe("/opt/cursor/old");
    expect(firstWindow.providerBinaryPathChangePending("cursor")).toBe(true);

    vi.resetModules();
    const secondWindow = await import("./providerBinaryPaths");
    await secondWindow.initializeProviderBinaryPaths();
    expect(secondWindow.runtimeProviderBinaryPath("cursor")).toBe("/opt/cursor/old");
    expect(secondWindow.providerBinaryPathChangePending("cursor")).toBe(true);

    mocks.invoke.mockResolvedValue({ cursor: "/opt/cursor/new" });
    vi.resetModules();
    const restartedWindow = await import("./providerBinaryPaths");
    await restartedWindow.initializeProviderBinaryPaths();
    expect(restartedWindow.runtimeProviderBinaryPath("cursor")).toBe("/opt/cursor/new");
    expect(restartedWindow.providerBinaryPathChangePending("cursor")).toBe(false);
  });

  it("clears a retired claude-grok path even when the runtime invoke fails", async () => {
    let stored = JSON.stringify({
      claude: "/Users/ash/.local/bin/claude-grok",
      codex: "/opt/codex",
    });
    vi.mocked(localStorage.getItem).mockImplementation(() => stored);
    vi.mocked(localStorage.setItem).mockImplementation((storageKey, value) => {
      if (storageKey === key) stored = value;
    });
    mocks.invoke.mockRejectedValue(new Error("timeout"));

    vi.resetModules();
    const providerPaths = await import("./providerBinaryPaths");
    await expect(providerPaths.initializeProviderBinaryPaths()).rejects.toThrow(
      "timeout",
    );

    expect(mocks.invoke).toHaveBeenCalledWith("harness_runtime_binary_paths", {
      paths: { codex: "/opt/codex" },
    });
    expect(providerPaths.runtimeProviderBinaryPath("claude")).toBeNull();
    expect(providerPaths.runtimeProviderBinaryPath("codex")).toBe("/opt/codex");
    expect(JSON.parse(stored)).toEqual({ codex: "/opt/codex" });
  });

  it("leaves a claude-deepseek path untouched", async () => {
    const stored = JSON.stringify({
      claude: "/Users/ash/.local/bin/claude-deepseek",
    });
    vi.mocked(localStorage.getItem).mockImplementation(() => stored);
    mocks.invoke.mockResolvedValue({
      claude: "/Users/ash/.local/bin/claude-deepseek",
    });

    vi.resetModules();
    const providerPaths = await import("./providerBinaryPaths");
    await providerPaths.initializeProviderBinaryPaths();

    expect(mocks.invoke).toHaveBeenCalledWith("harness_runtime_binary_paths", {
      paths: { claude: "/Users/ash/.local/bin/claude-deepseek" },
    });
    expect(providerPaths.runtimeProviderBinaryPath("claude")).toBe(
      "/Users/ash/.local/bin/claude-deepseek",
    );
    expect(stored).toBe(
      JSON.stringify({ claude: "/Users/ash/.local/bin/claude-deepseek" }),
    );
  });

  it("reports storage failures without claiming the path was saved", () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error("storage full");
    });
    expect(saveProviderBinaryPath("opencode", "/opt/opencode")).toBe(false);
  });
});
