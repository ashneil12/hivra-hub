import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { heldLineForSend, waitingOnYouLine } from "./approvalWait";

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

  it("names every open card, wherever it sits; a decided one is history", () => {
    const user = (id: string, draft = false): Block => ({ id, role: "user", text: id, ...(draft ? { draft: true } : {}) });
    // A card attaches to its tool block, which can sit before his last message: it still waits on him.
    const line = waitingOnYouLine([held("npm run old"), user("go on"), held("npm test")])!;
    expect(line).toContain("`npm test`");
    expect(line).toContain("(and 1 more)");
    expect(waitingOnYouLine([held("npm run old"), user("go on")])).toContain("`npm run old`");
    expect(waitingOnYouLine([held("npm run old", "allow"), user("go on")])).toBeNull();
    expect(waitingOnYouLine([user("a"), held("npm test"), user("half typed", true)])).toContain("`npm test`");
  });

  it("names a card whose record never arrived only when it came after his last message", () => {
    const user = (id: string, extra: Partial<Block> = {}): Block => ({ id, role: "user", text: id, ...extra });
    const lost: Block = { id: "lost", role: "approval", text: "Run the build" };
    expect(waitingOnYouLine([user("a"), lost])).toContain("Run the build");
    expect(waitingOnYouLine([user("a"), lost, user("note", { internal: true })])).toContain("Run the build");
    expect(waitingOnYouLine([lost, user("b")])).toBeNull();
  });

  describe("heldLineForSend: what Ash is told when his message does not go in", () => {
    const user: Block = { id: "u", role: "user", text: "go" };
    const parked = { busy: true, blocks: [user, held("npm test")] };
    const WAITS = "Waiting for approval to run `npm test`. Your message waits until you allow or deny it on the card above.";

    it("says it for a new message and for Steer on a message already waiting", () => {
      expect(heldLineForSend(parked)).toBe(WAITS);
      // The Steer button sends the queued message again, with its id: still Ash's own send, still told.
      expect(heldLineForSend(parked, { queuedMessageId: "q1" })).toBe(WAITS);
    });

    it("says nothing for the app's own sends, a chat nothing holds, an idle chat or the background-tasks branch", () => {
      expect(heldLineForSend(parked, { appRequestId: "r1" })).toBeNull();
      expect(heldLineForSend(parked, { monoNote: { text: "hi" } })).toBeNull();
      expect(heldLineForSend(parked, { monoSessionCompletion: { text: "done" } })).toBeNull();
      expect(heldLineForSend({ busy: true, blocks: [user, held("npm test", "allow")] })).toBeNull();
      expect(heldLineForSend({ ...parked, busy: false })).toBeNull();
      expect(heldLineForSend({ ...parked, backgroundTasks: ["dev server"] })).toBeNull();
    });
  });

  it("counts more than one card and keeps a long command short", () => {
    const line = waitingOnYouLine([held("npm test"), held(`find /Users/ash -name '*mcp*' ${"x".repeat(200)}`)])!;
    expect(line).toContain("(and 1 more)");
    expect(line.length).toBeLessThan(260);
  });
});
