import { afterEach, expect, it } from "vitest";
import { phaseBeforeCrew, phaseHint } from "./gate";
import { savePhaseSettings, setPhaseCrew, workFor } from "./store";

afterEach(() => {
  setPhaseCrew(undefined);
});

it("does not phase a usual task when the project default is product first", async () => {
  savePhaseSettings("/proj-small", { defaultPath: "product-first" });
  const gate = await phaseBeforeCrew("task-small-default", phaseHint({}), "/proj-small");
  expect(gate.hold).toBe(false);
  expect(gate.path).toBe("straight");
  expect(workFor("task-small-default")?.docs).toEqual([]);
});

it("asks for a product document when that is the default and the task is costly", async () => {
  savePhaseSettings("/proj-product", { defaultPath: "product-first" });
  setPhaseCrew(() => ({ body: "A person can read this." }));
  const gate = await phaseBeforeCrew("task-product", phaseHint({ hard: true }), "/proj-product");
  expect(gate.hold).toBe(true);
  expect(gate.path).toBe("product-first");
  expect(workFor("task-product")?.waiting?.phase).toBe("product");
  expect(workFor("task-product")?.docs.map((doc) => doc.body)).toEqual(["A person can read this."]);
});
