import { describe, expect, it } from "vitest";
import { knownStatus, STATUS_WORDS, statusWord } from "./words";

describe("status words", () => {
  it("uses only the five words", () => {
    expect(statusWord("working")).toBe("working");
    expect(statusWord("needs-you")).toBe("needs you");
    expect(statusWord("done")).toBe("done");
    expect(statusWord("failed")).toBe("failed");
    expect(statusWord("paused")).toBe("paused");
    expect(STATUS_WORDS).toEqual(["working", "needs you", "done", "failed", "paused"]);
  });

  it("does not treat a row's own state, or an unknown word, as a status", () => {
    expect(knownStatus("failed")).toBe("failed");
    expect(knownStatus("cancelled")).toBeNull();
    expect(knownStatus("stuck")).toBeNull();
    expect(knownStatus("running")).toBeNull();
    expect(knownStatus("")).toBeNull();
    expect(knownStatus(null)).toBeNull();
    expect(knownStatus(undefined)).toBeNull();
    expect(knownStatus(1)).toBeNull();
  });
});
