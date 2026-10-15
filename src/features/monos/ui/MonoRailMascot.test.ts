// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MonoRailMascot } from "./MonoRailMascot";

it("the sidebar avatar is a neutral letter tile, not a mascot", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(createElement(MonoRailMascot, { name: "ghost", color: "red", letter: "frank" })));
  const tile = el.querySelector("[data-mono-letter]")!;
  expect(tile.textContent).toBe("Fr");
  expect(tile.className).toContain("bg-content/12");
  expect(el.querySelector("svg, canvas")).toBeNull();
  act(() => root.unmount());
});
