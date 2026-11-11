import { expect, it } from "vitest";
import { defaultArrangement } from "./arrangement";
import { moveHomeSection } from "./arrangeHome";

it("moves a shown section past Projects without hiding Projects", () => {
  const moved = moveHomeSection(defaultArrangement(), "moving-now", -1);
  expect(moved.order.map((ref) => (ref.kind === "builtin" ? ref.id : "panel"))).toEqual([
    "moving-now",
    "projects",
    "needs-you",
    "recent",
  ]);
  expect(moved.hidden).toEqual([]);
});
