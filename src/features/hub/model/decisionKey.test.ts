// A chat answer to a person-only decision key is refused whatever its case or width. Red before the fold: the raw
// prefix check let "Irreversible/..." and "FRESH-EYES/..." through.
import { describe, expect, it } from "vitest";
import {
  foldDecisionKey,
  isFanoutAgainDecisionKey,
  isGateDecisionKey,
  isPersonOnlyDecisionKey,
  isFreshEyesDecisionKey,
  isIrreversibleDecisionKey,
  isSecretDecisionKey,
  isSecurityReviewDecisionKey,
} from "./decisionKey";

describe("foldDecisionKey", () => {
  it("folds case, width and padding the way decisions.rs fold_key does", () => {
    expect(foldDecisionKey(" Irreversible/lead/task-1 ")).toBe("irreversible/lead/task-1");
    expect(foldDecisionKey("ｉｒｒｅｖｅｒｓｉｂｌｅ/lead")).toBe("irreversible/lead");
    expect(foldDecisionKey("fresh-eyes／r1")).toBe("fresh-eyes/r1");
  });

  it("drops invisible format characters, so they cannot change the prefix", () => {
    expect(foldDecisionKey("irre\u200Bversible/x")).toBe("irreversible/x");
    expect(foldDecisionKey("\u200Birreversible/x")).toBe("irreversible/x");
    expect(foldDecisionKey("irreversible\u200C/x\u200D")).toBe("irreversible/x");
    expect(foldDecisionKey("irreversible\uFEFF/x\u00AD")).toBe("irreversible/x");
    expect(foldDecisionKey("irre\u2060versible/x")).toBe("irreversible/x");
    expect(foldDecisionKey("\uFE0Firreversible/x")).toBe("irreversible/x");
  });

  it("trims any Unicode white space the way str::trim does", () => {
    for (const space of ["\u00A0", "\u3000", "\u2028", "\u0085", "\u2003", " \t"]) {
      expect(foldDecisionKey(`${space}irreversible/x${space}`)).toBe("irreversible/x");
    }
  });
});

describe("person-only key checks", () => {
  it.each([
    "irreversible/lead/task-1",
    "Irreversible/lead/task-1",
    "IRREVERSIBLE/lead/task-1",
    " irreversible/lead/task-1",
    "ｉｒｒｅｖｅｒｓｉｂｌｅ/lead/task-1",
    "irre\u200Bversible/lead/task-1",
    "\u200Birreversible/lead/task-1",
    "\u00A0irreversible/lead/task-1",
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

  it.each([
    "fanout-again/r1/api/f2_r1-api/0123456789abcdef",
    "FANOUT-AGAIN/r1/api/f2_r1-api/0123456789abcdef",
    "ｆａｎｏｕｔ-ａｇａｉｎ/r1/api/f2_r1-api/0123456789abcdef",
    "fanout\u200B-again/r1/api/f2_r1-api/0123456789abcdef",
    "\u200Bfanout-again/r1/api/f2_r1-api/0123456789abcdef",
  ])("treats %j as a restart decision", (key) => {
    expect(isFanoutAgainDecisionKey(key)).toBe(true);
  });

  it("leaves an ordinary key alone", () => {
    expect(isIrreversibleDecisionKey("retention-policy")).toBe(false);
    expect(isFreshEyesDecisionKey("Retention-Policy")).toBe(false);
  });
});

describe("keys only the person answers", () => {
  it.each(["gate/run-7", "GATE/run-7", "\u200Bgate/run-7", "irreversible/lead/t", "fresh-eyes/r9/x", "fresh-eyes-start/r9", "fanout-again/fm/t"])(
    "%j is the person's alone",
    (key) => {
      expect(isPersonOnlyDecisionKey(key)).toBe(true);
    },
  );

  it("reads a gate key folded, like decisions.rs is_gate_key", () => {
    expect(isGateDecisionKey("ｇａｔｅ/run-7")).toBe(true);
    expect(isGateDecisionKey("gateway/run-7")).toBe(false);
  });

  it("folds a security review the way decisions.rs person_only does", () => {
    const keys = [
      "security-review/abc",
      "Security-Review/abc",
      `${String.fromCodePoint(0xff33)}ecurity-review/abc`,
      `security${String.fromCodePoint(0x200b)}-review/abc`,
      `  security-review/abc${String.fromCodePoint(0xfeff)}`,
      `SECURITY${String.fromCodePoint(0x00ad)}-REVIEW/ABC`,
      `security${String.fromCodePoint(0x070f)}-review/x`,
      `security${String.fromCodePoint(0x06dd)}-review/x`,
      `${String.fromCodePoint(0x110bd)}security-review/abc`,
    ];
    for (const key of keys) {
      expect(isSecurityReviewDecisionKey(key), JSON.stringify(key)).toBe(true);
      expect(isPersonOnlyDecisionKey(key), JSON.stringify(key)).toBe(true);
    }
  });

  it("folds a secret the same way", () => {
    const keys = [
      "secret/token-1",
      "Secret/token-1",
      `${String.fromCodePoint(0x200b)}secret/token-1`,
      `  secret/token-1${String.fromCodePoint(0xfeff)}`,
    ];
    for (const key of keys) {
      expect(isSecretDecisionKey(key), JSON.stringify(key)).toBe(true);
      expect(isPersonOnlyDecisionKey(key), JSON.stringify(key)).toBe(true);
    }
  });

  // PT-5 follow-up: a real bug's row on the test debt list (decisions.rs person_only): "Ship anyway" is the person's alone.
  it("reads a real bug's test debt row as the person's alone, and the rewrite-or-delete one as ordinary", () => {
    for (const key of [
      "test-debt-bug-0123456789abcdef-fedcba9876543210",
      "Test-Debt-Bug-0123456789abcdef-fedcba9876543210",
      `${String.fromCodePoint(0xff34)}est-debt-bug-0123456789abcdef-fedcba9876543210`,
      `test-debt${String.fromCodePoint(0x200b)}-bug-0123456789abcdef`,
    ]) {
      expect(isPersonOnlyDecisionKey(key), JSON.stringify(key)).toBe(true);
    }
    expect(isPersonOnlyDecisionKey("test-debt-score-0123456789abcdef")).toBe(false);
  });

  it("leaves an ordinary key to anyone", () => {
    expect(isPersonOnlyDecisionKey("copy/headline")).toBe(false);
    expect(isPersonOnlyDecisionKey("retention-policy")).toBe(false);
    expect(isSecurityReviewDecisionKey("security-review")).toBe(false);
    expect(isSecurityReviewDecisionKey("review/notes")).toBe(false);
    expect(isSecretDecisionKey("secrecy/token-1")).toBe(false);
    expect(isGateDecisionKey("gateway/run-7")).toBe(false);
  });
});
