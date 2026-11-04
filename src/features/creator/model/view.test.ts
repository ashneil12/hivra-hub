import { afterEach, describe, expect, it } from "vitest";
import { currentViewId } from "./view";

type WindowInternals = {
  __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
};

afterEach(() => {
  delete (globalThis as WindowInternals).__TAURI_INTERNALS__;
});

describe("currentViewId", () => {
  it("uses this window's label, and drops anything that isn't a view id", () => {
    expect(currentViewId()).toBe("main");
    (globalThis as WindowInternals).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "this-view" } } };
    expect(currentViewId()).toBe("this-view");
    (globalThis as WindowInternals).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "../other view!" } } };
    expect(currentViewId()).toBe("otherview");
    (globalThis as WindowInternals).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "" } } };
    expect(currentViewId()).toBe("main");
    (globalThis as WindowInternals).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "a".repeat(80) } } };
    expect(currentViewId()).toHaveLength(64);
  });
});
