// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenThreadContext } from "./OpenThreadContext";

describe("OpenThreadContext", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  function render(props: { open?: boolean; usage?: { used: number; window?: number }; empty?: boolean }) {
    act(() => {
      root.render(
        createElement(
          "div",
          null,
          createElement(
            "div",
            {
              "data-thread-scroll": "",
              style: { height: "40px", overflow: "auto" },
            },
            createElement("div", { style: { height: "800px" } }, "A long thread"),
          ),
          createElement(OpenThreadContext, props),
        ),
      );
    });
  }

  it("keeps the meter mounted while the open thread scrolls", () => {
    render({ usage: { used: 275765, window: 1048576 } });
    const scroller = container.querySelector<HTMLDivElement>("[data-thread-scroll]")!;
    const meter = container.querySelector("[data-open-thread-context]");
    expect(meter).toBeTruthy();
    expect(scroller.contains(meter)).toBe(false);
    expect(meter?.textContent).toContain("Context");
    expect(meter?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "26% context used, 276K / 1M tokens",
    );

    scroller.scrollTop = 600;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    expect(container.querySelector("[data-open-thread-context]")).toBe(meter);
    expect(meter?.isConnected).toBe(true);
    expect(scroller.contains(meter)).toBe(false);
  });

  it("stays mounted when the reading changes, and leaves when the thread closes", () => {
    render({ usage: { used: 10, window: 100 }, empty: false });
    const meter = container.querySelector("[data-open-thread-context]");
    render({ usage: { used: 90, window: 100 } });
    expect(container.querySelector("[data-open-thread-context]")).toBe(meter);
    expect(meter?.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("90% context used");

    render({ open: false, usage: { used: 90, window: 100 } });
    expect(container.querySelector("[data-open-thread-context]")).toBeNull();
  });

  it("still mounts for an empty thread and for a reading with no window", () => {
    render({ empty: true });
    expect(container.querySelector("[data-open-thread-context]")).toBeTruthy();
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("No context used yet");

    render({ usage: { used: 12 } });
    expect(container.querySelector("[data-context-unknown]")).toBeTruthy();
    expect(container.querySelector("[data-open-thread-context]")).toBeTruthy();
  });
});
