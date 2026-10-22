// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessUpdateNotice, updateTitle } from "./HarnessUpdateNotice";

let claimed = false;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "harness_update_check_claim") {
      const first = !claimed;
      claimed = true;
      return first;
    }
    if (command === "harness_latest_version") return "2.1.285";
    throw new Error(`unexpected ${command}`);
  }),
}));
vi.mock("../../../integrations/harness/core/availability", () => ({
  probeHarnessAvailability: vi.fn(async () => undefined),
  isHarnessAvailable: (id: string) => id === "claude",
}));
let installed = "2.1.284 (Claude Code)";
vi.mock("../../../integrations/harness/core/child", () => ({
  inspectHarnessBinary: vi.fn(async () => ({
    path: "/bin/claude",
    version: installed,
  })),
  updateHarnessCli: vi.fn(async () => {
    installed = "2.1.285 (Claude Code)";
  }),
}));
vi.mock("../../sessions/model/models", () => ({
  isPickerProviderVisible: () => true,
}));
const refreshHarnessCatalogs = vi.fn(async () => undefined);
vi.mock("../../../integrations/harness/core/registry", () => ({
  refreshHarnessCatalogs: (...args: unknown[]) =>
    refreshHarnessCatalogs(...(args as [])),
}));
const eventListeners = new Set<(event: { payload: unknown }) => void>();
const emit = vi.fn(async (_event: string, payload: unknown) => {
  eventListeners.forEach((listener) => listener({ payload }));
});
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: unknown) => emit(event, payload),
  listen: vi.fn(
    async (_event: string, listener: (event: { payload: unknown }) => void) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
  ),
}));
vi.mock("../../sessions/ui/HarnessIcon", () => ({ HarnessIcon: () => null }));

describe("HarnessUpdateNotice", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("survives a StrictMode remount and updates from the card", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(StrictMode, null, createElement(HarnessUpdateNotice)),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const notice = document.body.querySelector(
      '[aria-label="Agent updates"]',
    );
    expect(notice?.textContent).toContain("Claude Code");
    // No version numbers on the card (Ash, 22 Oct): the tool's name and Update.
    expect(notice?.textContent).not.toMatch(/\d+\.\d+\.\d+/);

    const update = Array.from(notice!.querySelectorAll("button")).find(
      (button) => button.textContent === "Update",
    )!;
    await act(async () => {
      update.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(notice?.textContent).toContain("Updated");
    expect(notice?.textContent).not.toMatch(/\d+\.\d+\.\d+/);
    expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["claude"], {
      force: true,
    });
    expect(refreshHarnessCatalogs).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("harness-updated", {
      harness: "claude",
      source: expect.any(String),
    });
    expect(notice?.textContent).toContain("Model picker refreshed");
    await act(async () => {
      await emit("harness-updated", {
        harness: "claude",
        source: "other-window",
      });
    });
    expect(refreshHarnessCatalogs).toHaveBeenCalledTimes(2);
    expect(refreshHarnessCatalogs).toHaveBeenLastCalledWith(["claude"], {
      force: true,
    });
    act(() => root.unmount());
  });

  it("on the hub's views sits bottom-left over the sidebar, stays dismissible, and takes no room from the top", async () => {
    // Still behind when re-checked: the card re-asks the CLI before showing.
    installed = "2.1.284 (Claude Code)";
    const container = document.createElement("div");
    const root = createRoot(container);
    const heights: number[] = [];
    await act(async () => {
      root.render(createElement(HarnessUpdateNotice, { placement: "bottom-left", onHeightChange: (h: number) => heights.push(h) }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const notice = document.body.querySelector<HTMLElement>('[aria-label="Agent updates"]')!;
    expect(notice.dataset.placement).toBe("bottom-left");
    expect(notice.style.bottom).toBe("36px");
    expect(notice.style.left).toBe("8px");
    expect(notice.style.top).toBe("");
    expect(notice.className).not.toContain("right-3");
    expect(heights.every((h) => h === 0)).toBe(true);
    const dismiss = notice.querySelector<HTMLButtonElement>('[aria-label="Dismiss harness updates"]')!;
    await act(async () => dismiss.click());
    expect(document.body.querySelector('[aria-label="Agent updates"]')).toBeNull();
    act(() => root.unmount());
  });
});

describe("HarnessUpdateNotice fresh checks and failures", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stillBehind drops a harness that is now current and refreshes the installed version", async () => {
    const { stillBehind } = await import("./HarnessUpdateNotice");
    const updates = [
      { harness: "claude" as const, installed: "2.1.296", latest: "2.1.300" },
      { harness: "codex" as const, installed: "0.1.0", latest: "0.3.0" },
    ];
    const next = await stillBehind(updates, async (id) =>
      id === "claude" ? "2.1.300 (Claude Code)" : "codex-cli 0.2.0",
    );
    expect(next).toEqual([{ harness: "codex", installed: "0.2.0", latest: "0.3.0" }]);
  });

  it("hides the card when the CLI is already current (no cached version)", async () => {
    vi.resetModules();
    claimed = false;
    installed = "2.1.285 (Claude Code)";
    const { HarnessUpdateNotice: Fresh } = await import("./HarnessUpdateNotice");
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Fresh)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.querySelector('[aria-label="Agent updates"]')).toBeNull();
    act(() => root.unmount());
  });

  it("an update that leaves the old version shows the plain failure with only Try again", async () => {
    vi.resetModules();
    claimed = false;
    installed = "2.1.284 (Claude Code)";
    const child = await import("../../../integrations/harness/core/child");
    vi.mocked(child.updateHarnessCli).mockImplementationOnce(async () => undefined);
    const { HarnessUpdateNotice: Fresh } = await import("./HarnessUpdateNotice");
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Fresh)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const notice = document.body.querySelector('[aria-label="Agent updates"]')!;
    const update = Array.from(notice.querySelectorAll("button")).find((b) => b.textContent === "Update")!;
    await act(async () => {
      update.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(notice.textContent).not.toContain("Updated to");
    const alert = notice.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Couldn't update Claude Code. Try again, or open Terminal for details.");
    expect(alert.textContent).not.toMatch(/\d+\.\d+\.\d+/);
    const buttons = Array.from(notice.querySelectorAll("button")).filter((b) => !b.getAttribute("aria-label"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Try again"]);
    act(() => root.unmount());
  });
});

describe("each release is offered once", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a release shown at one launch is not shown at the next, dismissed or not; a newer release is", async () => {
    const { notShownBefore } = await import("./HarnessUpdateNotice");
    const first = [{ harness: "claude" as const, installed: "2.1.304", latest: "2.1.307" }];
    expect(notShownBefore(first)).toEqual(first);
    // Next launch, same release still out: nothing.
    expect(notShownBefore(first)).toEqual([]);
    // A newer release is offered (once).
    const newer = [{ harness: "claude" as const, installed: "2.1.304", latest: "2.1.310" }];
    expect(notShownBefore(newer)).toEqual(newer);
    expect(notShownBefore(newer)).toEqual([]);
  });

  it("the card itself does not come back at the next launch for the release it showed", async () => {
    vi.resetModules();
    claimed = false;
    installed = "2.1.284 (Claude Code)";
    const first = await import("./HarnessUpdateNotice");
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(first.HarnessUpdateNotice, { placement: "bottom-left" })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.querySelector('[aria-label="Agent updates"]')).not.toBeNull();
    act(() => root.unmount());
    // A fresh launch (new module, new claim), same release still out.
    vi.resetModules();
    claimed = false;
    const second = await import("./HarnessUpdateNotice");
    const again = createRoot(document.createElement("div"));
    await act(async () => again.render(createElement(second.HarnessUpdateNotice, { placement: "bottom-left" })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.querySelector('[aria-label="Agent updates"]')).toBeNull();
    act(() => again.unmount());
  });
});

describe("the update card's title", () => {
  it("names the tool, never 'Harness'", () => {
    expect(updateTitle(["Claude Code"])).toBe("Claude Code update available");
    expect(updateTitle(["Claude Code", "Codex"])).toBe("2 agent updates available");
    expect(updateTitle(["Claude Code"])).not.toMatch(/harness/i);
  });
});
