import { describe, expect, it } from "vitest";
import { textAfterLoad, textAfterSave } from "./profileDraft";

describe("profile drafts", () => {
  it("keeps typed text when a load arrives late", () => {
    expect(textAfterLoad("from disk", false, "from disk")).toBe("from disk");
    expect(textAfterLoad("still typing", true, "from disk")).toBe("still typing");
  });

  it("keeps text typed during a save, and takes the saved copy when nothing else changed", () => {
    expect(textAfterSave("hello", "hello", "hello\n")).toEqual({ text: "hello\n", dirty: false });
    expect(textAfterSave("hello more", "hello", "hello\n")).toEqual({ text: "hello more", dirty: true });
  });
});
