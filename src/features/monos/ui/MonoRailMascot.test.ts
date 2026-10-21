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
  expect(tile.textContent).toBe("FR");
  expect(tile.className).toContain("bg-content/12");
  expect(el.querySelector("svg, canvas")).toBeNull();
  act(() => root.unmount());
});

it("a working dot is a stronger grey that pulses, not the Mono's own colour; idle is the plain grey", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(createElement(MonoRailMascot, { name: "robot", color: "hsl(45 90% 55%)", status: "working" })));
  const dot = el.querySelector<HTMLElement>("[data-mono-dot]")!;
  expect(dot.className).toContain("bg-content/60");
  expect(dot.style.backgroundColor).toBe("");
  expect(el.querySelector(".pixel-hop")).not.toBeNull();
  act(() => root.render(createElement(MonoRailMascot, { name: "robot", color: "hsl(45 90% 55%)", status: "idle" })));
  expect(el.querySelector("[data-mono-dot]")!.className).toContain("bg-content/30");
  expect(el.querySelector(".pixel-bob, .pixel-hop")).toBeNull();
  act(() => root.unmount());
});
