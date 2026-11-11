// @vitest-environment happy-dom
// G5: Home draws its cards in the saved arrangement's order, and a drop hands the new order back to be saved there.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defaultArrangement } from "../model/arrangement";
import { HomeScreen, type HomeChief } from "./HomeScreen";

const chief: HomeChief = {
  missing: false,
  name: "Coordinator",
  options: [],
  onAdd: () => undefined,
  onOpenChat: () => undefined,
  onOption: () => undefined,
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

function draw(props: Partial<Parameters<typeof HomeScreen>[0]> = {}) {
  act(() => {
    root.render(createElement(HomeScreen, {
      date: "Wednesday 11 November",
      chief,
      needs: [],
      needsTotal: 0,
      builders: [],
      working: [{ key: "w1", project: "Example", text: "Example: 1 worker", since: "" }],
      workingTotal: 1,
      done: [{ key: "d1", text: "Example: shipped", time: "" }],
      onSeeNeeds: () => undefined,
      arrangement: defaultArrangement(),
      catalog: [],
      known: true,
      failed: false,
      onOpen: () => undefined,
      onHide: () => undefined,
      onShow: () => undefined,
      onPin: () => undefined,
      onUnpin: () => undefined,
      onAsk: () => undefined,
      ...props,
    }));
  });
}

/** The cards as the page lays them out (each card's CSS order). */
const order = () =>
  [...container.querySelectorAll<HTMLElement>("[data-home-section]")]
    .sort((a, b) => Number(a.style.order) - Number(b.style.order))
    .map((el) => el.dataset.homeSection);

function drag(type: string, target: Element) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { setData: () => undefined, setDragImage: () => undefined, effectAllowed: "", dropEffect: "" },
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

it("draws the cards in the saved order, whatever this window kept before", () => {
  localStorage.setItem("monocode:home-card-order", JSON.stringify(["moving-now", "recent"]));
  draw({ arrangement: { ...defaultArrangement(), cards: ["recent", "moving-now"] } });
  expect(order()).toEqual(["recent", "moving-now"]);
});

it("a drop hands the new order to be saved and shows it at once", () => {
  const saved: string[][] = [];
  draw({ onReorder: (keys: string[]) => saved.push(keys) });
  expect(order()).toEqual(["moving-now", "recent"]);
  const grip = container.querySelector("[data-home-section='recent'] [data-home-grip]")!;
  const onto = container.querySelector("[data-home-section='moving-now']")!;
  drag("dragstart", grip);
  drag("dragover", onto);
  drag("drop", onto);
  expect(saved).toEqual([["recent", "moving-now"]]);
  expect(order()).toEqual(["recent", "moving-now"]);
  expect(localStorage.getItem("monocode:home-card-order")).toBeNull();
});
