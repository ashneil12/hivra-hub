import { expect, it } from "vitest";
import { appendControlEvent } from "./controlText";

const ack = "Starting with the hourly checker, then the rest.";
const answer = "Six asks. Here's what's true.";

it("puts a blank line between two finished assistant messages", () => {
  const events = [
    { type: "message.delta", text: ack },
    { type: "message.completed" },
    { type: "message.delta", text: answer },
    { type: "message.completed" },
  ];
  const reply = events
    .reduce((text, event) => appendControlEvent(text, event), "")
    .trim();
  expect(reply).toContain("then the rest.\n\nSix asks.");
  expect(reply).toBe(`${ack}\n\n${answer}`);
});

it("does not join a finished message with a single newline", () => {
  expect(appendControlEvent(ack, { type: "message.completed" })).toBe(`${ack}\n\n`);
});

it("leaves a tool event out of the reply, and caps a long one", () => {
  expect(appendControlEvent(ack, { type: "tool.started" })).toBe(ack);
  expect(appendControlEvent(ack, { type: "message.delta" })).toBe(ack);
  const filled = "x".repeat(20_000);
  expect(appendControlEvent(filled, { type: "message.delta", text: "y" })).toBe(
    `${"x".repeat(19_999)}y`,
  );
});
