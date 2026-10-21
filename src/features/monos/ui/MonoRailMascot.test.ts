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

it("can't tell: the creature is faded and still, with the same grey dot (no new colour); working moves", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(createElement(MonoRailMascot, { name: "robot", color: "hsl(30 80% 50%)", status: "unknown" })));
  const tile = el.querySelector("[data-mono-unsure]")!;
  expect(tile.className).not.toContain("opacity-40");
  // Only the creature fades: the dot keeps full strength, its place and its grey.
  expect(tile.querySelector("svg.pixel-mascot")!.getAttribute("class")).toContain("opacity-40");
  expect(el.querySelector(".pixel-bob, .pixel-hop, .pixel-eyes-open")).toBeNull();
  expect(el.querySelector("[data-mono-dot]")!.className).toContain("bg-content/30");
  act(() => root.render(createElement(MonoRailMascot, { name: "robot", color: "hsl(30 80% 50%)", status: "idle" })));
  expect(el.querySelector("[data-mono-unsure]")).toBeNull();
  expect(el.querySelector(".pixel-bob, .pixel-hop")).toBeNull();
  act(() => root.render(createElement(MonoRailMascot, { name: "robot", color: "hsl(30 80% 50%)", status: "working" })));
  expect(el.querySelector(".pixel-hop")).not.toBeNull();
  act(() => root.unmount());
});

it("'Not sure' is what can't tell reads as (rail title and label)", async () => {
  const { MONO_STATUS_LABEL } = await import("../model/mono");
  expect(MONO_STATUS_LABEL.unknown).toBe("Not sure");
});
