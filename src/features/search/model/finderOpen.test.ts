import { describe, expect, it } from "vitest";
import { finderFileOptions } from "./finderOpen";

describe("finder file open", () => {
  it("asks to open beside, and does not pin the tab", () => {
    expect(finderFileOptions(true)).toEqual({ exact: true, beside: true });
    expect(finderFileOptions(true).pin).toBeUndefined();
    expect(finderFileOptions(false)).toEqual({ exact: true, beside: false });
  });
});
