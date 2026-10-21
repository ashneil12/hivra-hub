// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { needMark } from "./StatusMark";

describe("a given-up job's mark", () => {
  afterEach(() => localStorage.clear());

  it("is red Stuck by default, whatever word Ash OS sends", () => {
    expect(needMark({ jobId: "j1", circle: "red", word: "Needs you" })).toEqual({ circle: "red", word: "Stuck" });
  });

  it("keeps Needs you only behind the dev flag", () => {
    localStorage.setItem("monocode:hub-gaveup-style", "needs_you");
    expect(needMark({ jobId: "j1", circle: "red", word: "Needs you" })).toEqual({ circle: "red", word: "Needs you" });
  });

  it("draws every Stuck row in the same red, leaves other rows as Ash OS marks them, and unmarked rows unmarked", () => {
    expect(needMark({ circle: "amber", word: "Stuck" })).toEqual({ circle: "red", word: "Stuck" });
    expect(needMark({ circle: "amber", word: "Sent to lead" })).toEqual({ circle: "amber", word: "Sent to lead" });
    expect(needMark({})).toBeNull();
  });
});
