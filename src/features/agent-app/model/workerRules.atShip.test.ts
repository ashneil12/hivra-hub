// PT-5: in a project that tests at ship, a worker's rules carry one sentence about failing tests it didn't write: note them in the
// report and carry on, never delete, skip or weaken one, and its own tests must pass. Every other mode keeps the rules as they were.
import { expect, it } from "vitest";
import { AT_SHIP_TESTS_RULE, workerRules } from "./agentAppTasks";

it("says the sentence the brief of the package names, and says it in one sentence", () => {
  expect(AT_SHIP_TESTS_RULE).toBe(
    "This project sorts failing tests at ship: if a test you did not write and that does not cover your change fails, note it in your report and carry on; never delete, skip or weaken it. Your own tests must pass.",
  );
  expect(AT_SHIP_TESTS_RULE).not.toMatch(/[–—]/);
});

it("is one more rule inside the worker rules in at-ship mode, and nothing in any other", () => {
  const plain = workerRules(41001);
  const atShip = workerRules(41001, { atShip: true });
  expect(plain).not.toContain(AT_SHIP_TESTS_RULE);
  expect(workerRules(41001, { atShip: false })).toBe(plain);
  expect(workerRules(41001, {})).toBe(plain);
  expect(atShip).toContain(`- ${AT_SHIP_TESTS_RULE}\n</worker_rules>`);
  // Everything else is exactly as it was.
  expect(atShip.replace(`- ${AT_SHIP_TESTS_RULE}\n`, "")).toBe(plain);
});

it("keeps the rule that a test is never weakened to get past a decision that isn't the worker's", () => {
  expect(workerRules(41001, { atShip: true })).toContain("Never weaken a test, an allow list or a guard");
});
