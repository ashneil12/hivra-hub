// r87 step 3: a word-for-word repeat within one turn is dropped (c02 r86 run 2, the Lead's checked updates said twice).
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../../features/sessions/model/session";
import { applyHarnessEvent, stopStreaming } from "./apply";
import { withoutTurnRepeats } from "./turnRepeats";

const b = (id: string, role: Block["role"], text: string, streaming = false): Block => ({ id, role, text, ...(streaming ? { streaming } : {}) });
const UPDATE = "Negative bumps now come back as `by cannot be negative`. Two jobs are still running.";

describe("a reply repeated word for word in one turn", () => {
  it("drops the later copy, after the Lead read the code in between", () => {
    const blocks = [
      b("u1", "user", "[MonoCode report] negative bump is back"),
      b("a1", "assistant", UPDATE),
      b("t1", "tool", "Read packages/shared/src/validate.ts"),
      b("a2", "assistant", `${UPDATE}\n`),
    ];
    expect(withoutTurnRepeats(blocks).map((x) => x.id)).toEqual(["u1", "a1", "t1"]);
  });

  it("keeps the same words in a later turn, different words, and a reply still streaming", () => {
    const blocks = [
      b("u1", "user", "report 1"),
      b("a1", "assistant", UPDATE),
      b("u2", "user", "report 2"),
      b("a2", "assistant", UPDATE),
      b("a3", "assistant", "The board now uses the shared tally type."),
      b("a4", "assistant", UPDATE, true),
    ];
    const out = withoutTurnRepeats(blocks);
    expect(out).toBe(blocks);
  });

  it("is dropped as the message completes, and at the turn's end", () => {
    const session = {
      id: "lead",
      busy: true,
      blocks: [b("u1", "user", "report"), b("a1", "assistant", UPDATE), b("a2", "assistant", UPDATE, true)],
    } as unknown as Session;
    expect(applyHarnessEvent(session, { type: "message.completed" } as never).blocks.map((x) => x.id)).toEqual(["u1", "a1"]);
    expect(stopStreaming(session).blocks.map((x) => x.id)).toEqual(["u1", "a1"]);
  });
});
