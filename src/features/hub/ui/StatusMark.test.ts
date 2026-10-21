// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { needMark } from "./StatusMark";

describe("a given-up job's mark", () => {
  afterEach(() => localStorage.clear());

  // D5, Ash 21 Oct 20:40: a job the Lead gave up on goes to Needs you, not a separate red Stuck.
  it("reads Needs you by default, whatever word Ash OS sends", () => {
    expect(needMark({ jobId: "j1", circle: "red", word: "Stuck" })).toEqual({ circle: "red", word: "Needs you" });
    expect(needMark({ jobId: "j1", circle: "red", word: "Needs you" })).toEqual({ circle: "red", word: "Needs you" });
  });

  it("keeps the old red Stuck only behind the dev flag", () => {
    localStorage.setItem("monocode:hub-gaveup-style", "stuck");
    expect(needMark({ jobId: "j1", circle: "red", word: "Needs you" })).toEqual({ circle: "red", word: "Stuck" });
  });

  it("draws every Stuck row in the same red, leaves other rows as Ash OS marks them, and unmarked rows unmarked", () => {
    expect(needMark({ circle: "amber", word: "Stuck" })).toEqual({ circle: "red", word: "Stuck" });
    expect(needMark({ circle: "amber", word: "Sent to lead" })).toEqual({ circle: "amber", word: "Sent to lead" });
    expect(needMark({})).toBeNull();
  });
});
