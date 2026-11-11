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

// Hivra WP-92 (fix round 2, C1): an agent's own shell line never invokes the secret launcher, with or without the grant.
import { credentialBlock, SECRET_ACTION_BLOCK_MESSAGE } from "./credentialGuard";

describe("Hivra WP-92: the launcher's invocation is blocked in any shell line", () => {
  it("blocks a direct monocode secret-run and a grant argument", () => {
    expect(credentialBlock({ command: "/Applications/MonoCode Hub.app/Contents/MacOS/monocode secret-run --grant-stdin" })).toBe(SECRET_ACTION_BLOCK_MESSAGE);
    expect(credentialBlock({ command: "$APP secret-run --grant-stdin" })).toBe(SECRET_ACTION_BLOCK_MESSAGE);
    expect(credentialBlock({ command: "printf %s \"$G\" | ./monocode secret-run --grant-stdin" })).toBe(SECRET_ACTION_BLOCK_MESSAGE);
  });

  it("leaves ordinary words alone", () => {
    expect(credentialBlock({ command: "git commit -m 'document the secret-run limit'" })).toBeUndefined();
  });
});
