// A chat answer to a person-only decision key is refused whatever its case or width. Red before the fold: the raw
// prefix check let "Irreversible/..." and "FRESH-EYES/..." through.
import { describe, expect, it } from "vitest";
import { foldDecisionKey, isFreshEyesDecisionKey, isIrreversibleDecisionKey } from "./decisionKey";

describe("foldDecisionKey", () => {
  it("folds case, width and padding the way decisions.rs fold_key does", () => {
    expect(foldDecisionKey(" Irreversible/lead/task-1 ")).toBe("irreversible/lead/task-1");
    expect(foldDecisionKey("ｉｒｒｅｖｅｒｓｉｂｌｅ/lead")).toBe("irreversible/lead");
    expect(foldDecisionKey("fresh-eyes／r1")).toBe("fresh-eyes/r1");
  });
});

describe("person-only key checks", () => {
  it.each([
    "irreversible/lead/task-1",
    "Irreversible/lead/task-1",
    "IRREVERSIBLE/lead/task-1",
    " irreversible/lead/task-1",
    "ｉｒｒｅｖｅｒｓｉｂｌｅ/lead/task-1",
  ])("treats %j as an irreversible step", (key) => {
    expect(isIrreversibleDecisionKey(key)).toBe(true);
  });

  it.each([
    "fresh-eyes/r1/00112233aabbccdd",
    "FRESH-EYES/r1/00112233aabbccdd",
    "Fresh-Eyes-Start/r1/00112233aabbccdd",
    "ｆｒｅｓｈ-ｅｙｅｓ/r1/00112233aabbccdd",
    "fresh-eyes／r1/00112233aabbccdd",
  ])("treats %j as a fresh-eyes review", (key) => {
    expect(isFreshEyesDecisionKey(key)).toBe(true);
  });

  it("leaves an ordinary key alone", () => {
    expect(isIrreversibleDecisionKey("retention-policy")).toBe(false);
    expect(isFreshEyesDecisionKey("Retention-Policy")).toBe(false);
  });
});
