import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { waitingOnYouLine } from "./approvalWait";

const held = (command: string, decided?: "allow"): Block =>
  ({ id: command, role: "assistant", text: "", tool: { title: "Bash" }, approval: { requestId: 1, ...(decided ? { decided } : {}), call: { tool: "Bash", command } } }) as Block;

describe("waitingOnYouLine (S14: a chat held on Ash's OK answers him at once)", () => {
  it("names what it waits to run and where to decide", () => {
    expect(waitingOnYouLine([held("npm install zod --workspace @tally/api")])).toBe(
      "Waiting for approval to run `npm install zod --workspace @tally/api`. Your message waits until you allow or deny it on the card above.",
    );
  });

  it("says nothing when no card waits on him", () => {
    expect(waitingOnYouLine([])).toBeNull();
    expect(waitingOnYouLine([held("npm test", "allow")])).toBeNull();
  });

  it("names only the cards since his last message; an older one is history", () => {
    const user = (id: string, draft = false): Block => ({ id, role: "user", text: id, ...(draft ? { draft: true } : {}) });
    const line = waitingOnYouLine([held("npm run old"), user("go on"), held("npm test")])!;
    expect(line).toContain("`npm test`");
    expect(line).not.toContain("npm run old");
    expect(waitingOnYouLine([held("npm run old"), user("go on")])).toBeNull();
    expect(waitingOnYouLine([user("a"), held("npm test"), user("half typed", true)])).toContain("`npm test`");
  });

  it("counts more than one card and keeps a long command short", () => {
    const line = waitingOnYouLine([held("npm test"), held(`find /Users/ash -name '*mcp*' ${"x".repeat(200)}`)])!;
    expect(line).toContain("(and 1 more)");
    expect(line.length).toBeLessThan(260);
  });
});
