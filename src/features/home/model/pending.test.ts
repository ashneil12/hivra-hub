import { afterEach, expect, it } from "vitest";
import { queueHomeDoc, queueHomeTask, resetHomePending, takeHomeDoc, takeHomeTask } from "./pending";

afterEach(resetHomePending);

it("holds a task until the list that has it takes it", () => {
  queueHomeTask("  ");
  expect(takeHomeTask(["t1"])).toBeNull();
  queueHomeTask(" t1 ");
  expect(takeHomeTask(["other"])).toBeNull();
  expect(takeHomeTask([])).toBeNull();
  expect(takeHomeTask(["t1", "t1"])).toBe("t1");
  expect(takeHomeTask(["t1"])).toBeNull();
  queueHomeTask("t2");
  queueHomeTask("t3");
  expect(takeHomeTask(["t2"])).toBeNull();
  expect(takeHomeTask(["t3"])).toBe("t3");
});

it("holds a doc on its own, so a task pane cannot take it", () => {
  queueHomeDoc("d1");
  queueHomeTask("t1");
  expect(takeHomeTask(["d1"])).toBeNull();
  expect(takeHomeDoc(["t1"])).toBeNull();
  expect(takeHomeDoc(["d1"])).toBe("d1");
  expect(takeHomeTask(["t1"])).toBe("t1");
});
