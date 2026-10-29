import { describe, expect, it } from "vitest";
import { sinceHeading } from "./hubData";

describe("r65: the Inbox says 'since' once", () => {
  it("a Since title reads just the time", () => {
    expect(sinceHeading("Since you were last here", "Since 2:10am")).toBe("Since 2:10am");
    expect(sinceHeading("Since you were away", "Since yesterday")).toBe("Since yesterday");
  });
  it("any other title keeps the time after a dot", () => {
    expect(sinceHeading("What changed", "Since 2:10am")).toBe("What changed · since 2:10am");
  });
  it("never says since twice", () => {
    for (const title of ["Since you were last here", "since then", "What changed"])
      expect(sinceHeading(title, "Since 9pm").toLowerCase().match(/since/g)?.length).toBe(1);
  });
});
