// r76 (CoS): no em dashes in anything Ash reads, in the saved chat too, not only on screen. A finished reply is stored
// without them; code keeps its dashes, and a number range keeps a dash (an en dash).
import { expect, it } from "vitest";
import { applyHarnessEvent, applyHarnessEvents } from "./apply";
import { newSession } from "../../../features/sessions/model/session";
import { withoutEmDashes } from "../../../shared/text/noEmDash";

const reply = "Fixed it — the button is 48px.\n\nPages 10—20 next.\n\n```sh\necho a — b\n```\nRun `x — y` after.";

it("a finished reply is saved without em dashes", () => {
  let session = applyHarnessEvents(newSession("claude", "/tmp"), [{ type: "message.delta", text: reply }]);
  const streaming = session.blocks.at(-1)!;
  expect(streaming.streaming).toBe(true);
  expect(streaming.text).toBe(reply);
  session = applyHarnessEvent(session, { type: "message.completed" } as never);
  const saved = session.blocks.at(-1)!;
  expect(saved.streaming).toBe(false);
  expect(saved.text).toBe("Fixed it, the button is 48px.\n\nPages 10–20 next.\n\n```sh\necho a — b\n```\nRun `x — y` after.");
});

it("a number range keeps a dash", () => {
  expect(withoutEmDashes("pages 10—20, or 3 — 5")).toBe("pages 10–20, or 3–5");
});
