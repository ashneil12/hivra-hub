import { describe, expect, it } from "vitest";
import { mapProject } from "./hubStore";

describe("the strip's project carries the team share flag (WP-80)", () => {
  it("passes shared through only when it is true", () => {
    expect(mapProject({ id: "exo", name: "EXO", shared: true })?.shared).toBe(true);
    expect(mapProject({ id: "exo", name: "EXO", shared: false })?.shared).toBeUndefined();
    expect(mapProject({ id: "exo", name: "EXO" })?.shared).toBeUndefined();
  });
});
