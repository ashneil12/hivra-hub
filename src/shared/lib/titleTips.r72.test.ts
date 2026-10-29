// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTitleTips, TITLE_TIP_DELAY_MS } from "./titleTips";

function over(el: Element, from: Element | null = null) {
  el.dispatchEvent(
    new MouseEvent("mouseover", {
      bubbles: true,
      relatedTarget: from,
      clientX: 50,
      clientY: 60,
    }),
  );
}
function out(el: Element, to: Element | null) {
  el.dispatchEvent(
    new MouseEvent("mouseout", { bubbles: true, relatedTarget: to }),
  );
}
const tip = () => document.querySelector<HTMLElement>("[data-hub-title-tip]");

describe("r72 (c): title tips are drawn in the page, never as a native window", () => {
  let uninstall: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div id="row" title="git log --oneline -5"><span id="inner">Ran git</span></div><div id="other">x</div>';
    uninstall = installTitleTips(document);
  });
  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  it("holds the title while hovered so the native tip never fires, and shows its own after a pause", () => {
    const row = document.getElementById("row")!;
    over(document.getElementById("inner")!);
    expect(row.hasAttribute("title")).toBe(false);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(TITLE_TIP_DELAY_MS);
    expect(tip()?.textContent).toBe("git log --oneline -5");
    expect(tip()?.getAttribute("role")).toBe("tooltip");
  });

  it("the tip goes when the hovered element leaves the page (the r67 lingering tip)", () => {
    over(document.getElementById("inner")!);
    vi.advanceTimersByTime(TITLE_TIP_DELAY_MS);
    expect(tip()).not.toBeNull();
    document.getElementById("row")!.remove(); // navigated away, pointer never moved
    vi.advanceTimersByTime(200);
    expect(tip()).toBeNull();
  });

  it("the tip goes on leave, press, key, scroll and window blur, and the title comes back", () => {
    const row = document.getElementById("row")!;
    const other = document.getElementById("other")!;
    for (const end of [
      () => out(row, other),
      () => document.dispatchEvent(new Event("pointerdown")),
      () =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
      () => document.dispatchEvent(new Event("scroll")),
      () => window.dispatchEvent(new Event("blur")),
    ]) {
      over(document.getElementById("inner")!);
      vi.advanceTimersByTime(TITLE_TIP_DELAY_MS);
      expect(tip()).not.toBeNull();
      end();
      expect(tip()).toBeNull();
      expect(row.getAttribute("title")).toBe("git log --oneline -5");
    }
  });

  it("moving inside the element keeps one tip; a title set again while held is taken back", () => {
    const row = document.getElementById("row")!;
    over(row);
    over(document.getElementById("inner")!, row);
    vi.advanceTimersByTime(TITLE_TIP_DELAY_MS);
    expect(document.querySelectorAll("[data-hub-title-tip]")).toHaveLength(1);
    row.setAttribute("title", "git status");
    vi.advanceTimersByTime(200);
    expect(row.hasAttribute("title")).toBe(false);
    expect(tip()?.textContent).toBe("git status");
  });

  it("the innermost titled element wins", () => {
    document.getElementById("inner")!.setAttribute("title", "inner tip");
    over(document.getElementById("inner")!);
    vi.advanceTimersByTime(TITLE_TIP_DELAY_MS);
    expect(tip()?.textContent).toBe("inner tip");
    expect(document.getElementById("row")!.getAttribute("title")).toBe(
      "git log --oneline -5",
    );
  });
});
