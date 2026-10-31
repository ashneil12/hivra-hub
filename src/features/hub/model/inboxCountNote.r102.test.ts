// r102 (4, 8, 9, 12): the status turn carries the answer's shape and names the other chats' Inbox asks, so the Lead
// points to them in one line instead of relisting them (05bc relisted Chief of Staff's privacy page and refunds FAQ).
import { expect, it } from "vitest";
import { inboxCountLine, STATUS_SHAPE } from "./inboxCountNote";

it("names other chats' asks in the same pointer line and forbids relisting them", () => {
  const line = inboxCountLine(["Which shortcut for a new chat?"], ["May Tally draft the privacy page?", "Stripe may still be in test mode"]);
  expect(line).toContain('"waiting on you" is exactly 1');
  expect(line).toContain("Also on his Inbox from other chats");
  expect(line).toContain("Tally draft the privacy page");
  expect(line).toContain("Never relist any of these decisions anywhere else in the reply");
});

it("always gives the short shape: count line first, already there counts as done, under 15 lines, plain words", () => {
  for (const line of [inboxCountLine([]), inboxCountLine(["Which shortcut?"])]) expect(line).toContain(STATUS_SHAPE);
  expect(STATUS_SHAPE).toMatch(/count line first/);
  expect(STATUS_SHAPE).toMatch(/already there counts as done/);
  expect(STATUS_SHAPE).toMatch(/under 15 lines/);
  expect(STATUS_SHAPE).toMatch(/no "the same hold"/);
});
