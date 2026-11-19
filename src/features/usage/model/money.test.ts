// WP-176 review LOW 13: a typed amount is either a plain positive dollar figure or refused, never silently read.
import { describe, expect, it } from "vitest";
import { dollarsOrBad, formatUsd, parseDollars } from "./money";

describe("typed dollar amounts", () => {
  it("accepts plain digits with an optional cent part", () => {
    expect(parseDollars("50")).toBe(50);
    expect(parseDollars(" 12.5 ")).toBe(12.5);
    expect(parseDollars("12.50")).toBe(12.5);
  });

  it("refuses every form the old Number() read silently", () => {
    for (const text of ["$50", "1,000", "0", "1e3", "0x10", "-5", "abc", "50 USD"]) {
      expect(parseDollars(text), text).toBe("bad");
    }
    expect(parseDollars("")).toBeNull();
  });

  it("refuses a non-finite or oversize number and rounds to the micro-dollar", () => {
    expect(dollarsOrBad(Number.NaN)).toBe("bad");
    expect(dollarsOrBad(2_000_000_000)).toBe("bad");
    expect(dollarsOrBad(0.1234567)).toBe(0.123457);
  });

  it("formats whole dollars without cents and otherwise two decimals", () => {
    expect(formatUsd(50)).toBe("$50");
    expect(formatUsd(12.4)).toBe("$12.40");
  });
});
