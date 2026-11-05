import { describe, expect, it } from "vitest";
import { SECRET_ACTION_DENY_RULES } from "./credentialGuard";

// Hivra WP-92: the one-run launcher is the app's signed call, never a worker's own shell line.
describe("Hivra WP-92: the secret launcher is denied to every agent", () => {
  it("names monocode secret-run in the Bash deny rules", () => {
    expect(SECRET_ACTION_DENY_RULES).toContain("Bash(*monocode secret-run*)");
  });

  it("keeps the rest of the secret rules in place", () => {
    // The grant's signature is the guard that matters; the deny rule only stops a worker invoking the launcher.
    for (const rule of ["Bash(op run:*)", "Bash(*printenv *KEY*)", "Bash(*doppler run*)"]) {
      expect(SECRET_ACTION_DENY_RULES).toContain(rule);
    }
  });
});
