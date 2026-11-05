import { expect, it } from "vitest";
import { begin, counter } from "./machine";
import { commitWork, workFor, writePhaseRaw } from "./store";

it("keeps the first write when a second window still has the old version", () => {
  const work = begin("task-cas", { weight: "small" }, {}, counter());
  const first = commitWork({ ...work, why: "first window" }, 0);
  expect(first.stale).toBe(false);
  const second = commitWork({ ...work, why: "second window" }, 0);
  expect(second.stale).toBe(true);
  expect(second.work.why).toBe("first window");
  expect(workFor("task-cas")?.why).toBe("first window");
});

it("reads garbage as no phase work", () => {
  writePhaseRaw("task-garbage", "{");
  expect(workFor("task-garbage")).toBeUndefined();
  writePhaseRaw("task-garbage", "{\"path\":\"sideways\"}");
  expect(workFor("task-garbage")).toBeUndefined();
});
