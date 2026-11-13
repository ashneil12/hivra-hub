// SC-7: "never paste test output" was a sentence. Now a worker runs its tests with the run_checks tool, which saves the full
// log and returns only the summary line and each failing test, and a bug fix shows a failing run of its test first (the app
// checks the order: src-tauri/src/firstmate/fact_gaps.rs).
import { expect, it } from "vitest";
import { workerRules } from "./agentAppTasks";

it("tells every worker to run its tests with run_checks and not to run the test command itself", () => {
  const rules = workerRules(41001);
  expect(rules).toContain("run_checks");
  expect(rules).toMatch(/Run your tests with the run_checks tool instead of running the test command yourself/);
  expect(rules).toContain("the path of the full log");
});

it("tells a worker fixing a bug to write the failing test first and run it before changing the code", () => {
  const rules = workerRules(41001);
  expect(rules).toMatch(/fixing a bug, write the test that fails first and run it with run_checks before you change the code/);
  expect(rules).toContain("a build error or zero tests is not a failing run");
});

it("keeps the rules that were there: affected tests, short reports, never paste output", () => {
  const rules = workerRules(41001);
  expect(rules).toContain("Test what your change can reach, not the whole suite");
  expect(rules).toContain("never paste test or command output");
});

it("uses no long dash in the new words", () => {
  const rules = workerRules(41001);
  const line = rules.split("\n").find((l) => l.includes("run_checks")) ?? "";
  expect(line).not.toMatch(/[–—]/);
});
