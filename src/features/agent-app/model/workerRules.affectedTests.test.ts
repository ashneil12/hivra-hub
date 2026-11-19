// Hivra (11 Nov 2026, Ash: "make work on Dropwave do that by default"): every worker tests what its change can reach,
// in any project, and keeps the full suite for when it is asked for or the change touches what every test stands on.
import { expect, it } from "vitest";
import { workerRules } from "./agentAppTasks";

it("every worker runs the tests its change can reach, and the full suite only when that is called for", () => {
  const rules = workerRules(41001);
  expect(rules).toContain("Test what your change can reach, not the whole suite");
  for (const tool of ["npm run check:affected", "vitest related", "jest --findRelatedTests", "cargo test -p <crate>"]) {
    expect(rules).toContain(tool);
  }
  expect(rules).toMatch(/Run the full suite only when your brief asks, when you changed what every test stands on \(the package manifest, the lockfile/);
  expect(rules).toContain("your report says which you ran");
});
