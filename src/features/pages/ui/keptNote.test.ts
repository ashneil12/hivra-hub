import { expect, it } from "vitest";
// Imported up front: PagesView pulls in the hub's stores, and loading them inside a test can pass its 5 s limit on a busy Mac.
import { allowedLabel } from "./PagesView";

it("a kept page's line reads Allowed: N things", () => {
  expect(allowedLabel(1)).toBe("Allowed: 1 thing");
  expect(allowedLabel(3)).toBe("Allowed: 3 things");
});
