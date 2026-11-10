import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { waitingOnYouLine } from "./approvalWait";

const held = (command: string, decided?: "allow"): Block =>
  ({ id: command, role: "assistant", text: "", tool: { title: "Bash" }, approval: { requestId: 1, ...(decided ? { decided } : {}), call: { tool: "Bash", command } } }) as Block;

describe("waitingOnYouLine (S14: a chat held on Ash's OK answers him at once)", () => {
  it("names what it waits to run and where to decide", () => {
    expect(waitingOnYouLine([held("npm install zod --workspace @tally/api")])).toBe(
      "Waiting for approval to run `npm install zod --workspace @tally/api`. Your message waits until you allow or deny it.",
    );
  });

  it("says nothing when no card waits on him", () => {
    expect(waitingOnYouLine([])).toBeNull();
    expect(waitingOnYouLine([held("npm test", "allow")])).toBeNull();
  });

  it("counts more than one card and keeps a long command short", () => {
    const line = waitingOnYouLine([held("npm test"), held(`find /Users/ash -name '*mcp*' ${"x".repeat(200)}`)])!;
    expect(line).toContain("(and 1 more)");
    expect(line.length).toBeLessThan(260);
  });
});
