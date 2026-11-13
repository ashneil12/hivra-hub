// PT-5: what a worker is told to do when a test goes red, in every testing mode but "No testing". One set of short rules; only the
// second one changes with the mode ("Test at ship" hands a red test that isn't the worker's to the test list, "Light" and "Full"
// quarantine it for 14 days).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AT_SHIP_TESTS_RULE, QUARANTINE_DAYS, redTestRules, workerRules, type RedTestMode } from "./agentAppTasks";

const MODES: RedTestMode[] = ["at-ship", "light", "full"];

describe("the red-test rules", () => {
  it("are six short rules, in plain words, with no dashes", () => {
    for (const mode of MODES) {
      const rules = redTestRules(mode);
      expect(rules, mode).toHaveLength(6);
      for (const rule of rules) {
        expect(rule, `${mode}: ${rule}`).not.toMatch(/[–—]/);
        expect(rule.length, rule).toBeLessThan(420);
        expect(rule).not.toMatch(/\n/);
      }
    }
  });

  it("say first which kind of red it is: a real bug, a test out of date on purpose, or flaky", () => {
    for (const mode of MODES) {
      const first = redTestRules(mode)[0];
      expect(first).toMatch(/first say in one line which it is/);
      expect(first).toMatch(/a real bug/);
      expect(first).toMatch(/out of date because the behaviour changed on purpose/);
      expect(first).toMatch(/flaky \(it passes when run again on the same commit\)/);
    }
  });

  it("limit the time on a red test that isn't the worker's to 10 minutes or 2 attempts, then hand it on by mode", () => {
    for (const mode of MODES) {
      expect(redTestRules(mode)[1]).toMatch(/^Spend at most 10 minutes or 2 attempts on a red test that is not one of yours\. /);
    }
    const atShip = redTestRules("at-ship")[1];
    expect(atShip).toMatch(/project's test list/);
    expect(atShip).toMatch(/sorted at ship/);
    expect(atShip).not.toMatch(/quarantine/i);
    for (const mode of ["light", "full"] as const) {
      const second = redTestRules(mode)[1];
      expect(second, mode).toMatch(/if it is not a critical test/);
      expect(second, mode).toContain(`${QUARANTINE_DAYS} day quarantine`);
      expect(second, mode).toContain('"Quarantine: <test> | <why>"');
      expect(second, mode).toMatch(/name it in your report/);
      expect(second, mode).toMatch(/never quarantine a critical test: ask your first mate/);
      expect(second, mode).not.toMatch(/test list/);
    }
    // Light and Full say the same thing.
    expect(redTestRules("light")).toEqual(redTestRules("full"));
  });

  it("forbid making a test pass by weakening it, and ask for what a deletion needs", () => {
    for (const mode of MODES) {
      const third = redTestRules(mode)[2];
      for (const word of ["removed assertions", "loosened expected values", "skips", "retries", "sleeps"]) {
        expect(third, `${mode}: ${word}`).toContain(word);
      }
      expect(third).toMatch(/what behaviour it guarded and what covers it now/);
    }
  });

  it("keep tests marked critical, golden files and formal specs read-only, and say how a test is marked critical", () => {
    for (const mode of MODES) {
      const fourth = redTestRules(mode)[3];
      expect(fourth).toMatch(/critical/);
      expect(fourth).toMatch(/golden files/);
      expect(fourth).toMatch(/formal specs/);
      expect(fourth).toMatch(/read-only for you/);
      expect(fourth).toMatch(/needs your first mate/);
      expect(fourth).toContain("`@critical`");
      expect(fourth).toMatch(/keys, permissions, the sandbox, billing, migrations, CI or installers/);
    }
  });

  it("say that the change you land owns the red it causes, and that a change gets at most 3 review rounds", () => {
    for (const mode of MODES) {
      expect(redTestRules(mode)[4]).toMatch(/The change you land owns the red it causes/);
      const rounds = redTestRules(mode)[5];
      expect(rounds).toMatch(/at most 3 review rounds/);
      expect(rounds).toMatch(/the checks stop sending it back after the third/);
      expect(rounds).toMatch(/rethink the approach/);
    }
  });

  it("use the same 14 days as the test debt list's quarantine", () => {
    expect(QUARANTINE_DAYS).toBe(14);
    const doc = readFileSync(join(process.cwd(), "src-tauri/src/test_debt/doc.rs"), "utf8");
    expect(doc).toMatch(/pub const QUARANTINE_MS: u64 = 14 \* 24 \* 60 \* 60 \* 1000;/);
  });
});

describe("workerRules with the red-test rules", () => {
  it("is exactly what it was when no mode is given", () => {
    const plain = workerRules(41001);
    expect(workerRules(41001, {})).toBe(plain);
    expect(workerRules(41001, { redTests: undefined })).toBe(plain);
    expect(plain).not.toContain("When a test goes red");
  });

  it("adds the six rules, once each, as the last rules, and nothing else", () => {
    const plain = workerRules(41001);
    for (const mode of MODES) {
      const rules = workerRules(41001, { redTests: mode });
      const added = redTestRules(mode)
        .map((rule) => `- ${rule}\n`)
        .join("");
      expect(rules).toContain(`${added}</worker_rules>`);
      expect(rules.replace(added, "")).toBe(plain);
      for (const rule of redTestRules(mode)) expect(rules.split(rule), rule).toHaveLength(2);
    }
  });

  it("keeps the at-ship sentence first, so a project that sorts at ship hears both", () => {
    const both = workerRules(41001, { atShip: true, redTests: "at-ship" });
    const sentence = `- ${AT_SHIP_TESTS_RULE}\n`;
    const first = `- ${redTestRules("at-ship")[0]}\n`;
    expect(both).toContain(`${sentence}${first}`);
    expect(both.split(AT_SHIP_TESTS_RULE)).toHaveLength(2);
    // Still no loosening anywhere in the rules.
    expect(both).toContain("Never weaken a test, an allow list or a guard");
  });
});
