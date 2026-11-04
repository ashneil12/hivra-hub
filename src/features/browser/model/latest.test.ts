import { describe, expect, it } from "vitest";
import { takeLatest } from "./latest";

describe("takeLatest", () => {
  it("keeps the reply that matches the newest ask", () => {
    expect(takeLatest(2, 2, ["Ada"])).toEqual(["Ada"]);
  });

  it("drops a reply that arrives after a newer ask", () => {
    expect(takeLatest(1, 2, ["Ada", "Milo"])).toBeUndefined();
  });

  it("drops a reply for an ask that was never current", () => {
    expect(takeLatest(0, 1, [])).toBeUndefined();
  });
});
