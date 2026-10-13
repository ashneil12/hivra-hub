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
  vi.unstubAllEnvs();
});

describe("provider binary paths", () => {
  it("uses the CC Studio wrapper only when no explicit Claude binary is configured", async () => {
    vi.stubEnv("VITE_CC_STUDIO_CLAUDE_BINARY", "/studio/cc-studio-claude");
    mocks.invoke.mockImplementation(async (_command, args) => args.paths);
    vi.resetModules();
    const paths = await import("./providerBinaryPaths");
    await paths.initializeProviderBinaryPaths();
    expect(paths.runtimeProviderBinaryPath("claude")).toBe("/studio/cc-studio-claude");
    expect(paths.loadProviderBinaryPath("claude")).toBe("/studio/cc-studio-claude");
    expect(paths.providerBinaryPathChangePending("claude")).toBe(false);
    expect(paths.isCcStudioClaudeRuntime()).toBe(true);

    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify({ claude: "/custom/claude" }));
    await paths.initializeProviderBinaryPaths();
    expect(mocks.invoke).toHaveBeenLastCalledWith("harness_runtime_binary_paths", {
      paths: { claude: "/custom/claude" },
    });
    expect(paths.runtimeProviderBinaryPath("claude")).toBe("/custom/claude");
    expect(paths.isCcStudioClaudeRuntime()).toBe(false);
  });

  it("does not enable upstream models in a plain build without a launcher", async () => {
    vi.stubEnv("VITE_CC_STUDIO_CLAUDE_BINARY", "");
    mocks.invoke.mockImplementation(async (_command, args) => args.paths);
    vi.resetModules();
    const paths = await import("./providerBinaryPaths");
    await paths.initializeProviderBinaryPaths();
    expect(paths.runtimeProviderBinaryPath("claude")).toBeNull();
    expect(paths.isCcStudioClaudeRuntime()).toBe(false);
  });

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

  it("reports storage failures without claiming the path was saved", () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error("storage full");
    });
    expect(saveProviderBinaryPath("opencode", "/opt/opencode")).toBe(false);
  });
});
