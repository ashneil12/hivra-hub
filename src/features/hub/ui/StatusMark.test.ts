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

  it("keeps red for Needs you only: a Stuck row is a grey Retrying, a Sent to lead row a grey With its lead, unmarked rows unmarked", () => {
    expect(needMark({ circle: "amber", word: "Stuck" })).toEqual({ circle: "grey", word: "Retrying" });
    expect(needMark({ circle: "amber", word: "Sent to lead" })).toEqual({ circle: "grey", word: "With its lead" });
    expect(needMark({ circle: "red", word: "Needs you" })).toEqual({ circle: "red", word: "Needs you" });
    expect(needMark({})).toBeNull();
  });
});
