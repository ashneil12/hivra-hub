import { describe, expect, it } from "vitest";
import { modelNote, visibleModelNote } from "./modelNotes";

const FABLE_NOTE = "Effort levels may behave differently from Fable 5.1.";

describe("model notes", () => {
  it("seeds a note for Fable 5.2 by catalog id, native id, or alias target", () => {
    expect(modelNote({ id: "claude:fable-5-2" })).toBe(FABLE_NOTE);
    expect(modelNote({ id: "claude-fable-5-2" })).toBe(FABLE_NOTE);
    expect(
      modelNote({ id: "claude:fable", nativeId: "claude-fable-5-2" }),
    ).toBe(FABLE_NOTE);
    expect(
      modelNote({ id: "claude:fable", aliasTarget: "claude-fable-5-2" }),
    ).toBe(FABLE_NOTE);
  });

  it("returns nothing for a model with no note, or a blank note", () => {
    expect(modelNote({ id: "claude:opus-5-5" })).toBeUndefined();
    expect(modelNote({ id: "claude:fable-5", nativeId: "claude-fable-5" })).toBeUndefined();
    expect(modelNote({ id: "claude:fable-5-1", nativeId: "claude-fable-5-1" })).toBeUndefined();
    expect(modelNote({ id: "" })).toBeUndefined();
    expect(visibleModelNote(undefined)).toBeUndefined();
    expect(visibleModelNote("")).toBeUndefined();
    expect(visibleModelNote("   ")).toBeUndefined();
    expect(visibleModelNote(`  ${FABLE_NOTE}  `)).toBe(FABLE_NOTE);
  });
});
