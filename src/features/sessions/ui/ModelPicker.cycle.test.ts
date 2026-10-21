// Port map idea 2: a click on the model name moves to the next model and wraps (UniiChat Pick.ts move).
import { expect, it } from "vitest";
import { nextModel } from "./ModelPicker";

const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

it("moves +1 and wraps round", () => {
  expect(nextModel(list, "a")?.id).toBe("b");
  expect(nextModel(list, "c")?.id).toBe("a");
});

it("an unlisted model moves to the first; an empty list has none", () => {
  expect(nextModel(list, "zz")?.id).toBe("a");
  expect(nextModel([], "a")).toBeUndefined();
});
