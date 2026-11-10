// WP-101 review round 4: the timer check in TypeScript and in Rust must hold the same commands. The cases are one shared
// file (src/shared/security/approvalParity.json); this side runs them through the timer's own verdict (the table and
// walk, then the login words, as agentAppTimers.ts takes it), and watcher/safe_cmd.rs runs the same file. Rust never
// approves what TypeScript holds: with these inputs the two must match exactly.
import { describe, expect, it } from "vitest";
import cases from "../../../shared/security/approvalParity.json";
import { commandNamesLogin, safeCommand } from "./safeApproval";

const timerHolds = (command: string) => safeCommand(command) ?? commandNamesLogin(command);

describe("timer parity with the Rust check", () => {
  it("has a shared set large enough to mean something", () => {
    expect(cases.cases.length).toBeGreaterThan(90);
  });

  for (const entry of cases.cases) {
    it(`${entry.held ? "holds" : "allows"} ${entry.command}`, () => {
      const verdict = timerHolds(entry.command);
      expect(verdict !== null, `${entry.command}: ${verdict ?? "allowed"}`).toBe(entry.held);
    });
  }
});
