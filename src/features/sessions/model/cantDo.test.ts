import { describe, expect, it } from "vitest";
import {
  blocksBusySend,
  cantRedirectTurn,
  cantTakeFollowUp,
  followUpWhenBusy,
  redirectNotePlace,
} from "./cantDo";

const DASH = /[—–]/;

describe("can't redirect a running turn", () => {
  it("names the agent and says to stop, with no dash", () => {
    const cases = [
      ["grok", "Grok Build"],
      ["fx", "fx"],
      ["devin", "Devin"],
      ["antigravity", "Antigravity"],
    ] as const;
    for (const [id, title] of cases) {
      const text = cantRedirectTurn(id);
      expect(text).toBe(
        `${title} can't redirect a running turn. Stop it, then send.`,
      );
      expect(text).not.toMatch(DASH);
    }
  });

  it("keeps the mid-turn fallback in plain words", () => {
    const text = cantTakeFollowUp("fx");
    expect(text).toBe(
      "fx can't take a follow-up mid-turn. Wait for this turn to finish, or stop it first.",
    );
    expect(text).not.toMatch(DASH);
    expect(cantTakeFollowUp("hermes")).not.toMatch(DASH);
  });

  it("queues a typed message instead of turning Send into Stop when the agent cannot redirect", () => {
    expect(followUpWhenBusy(true, "steer")).toBe("queue");
    expect(followUpWhenBusy(true, "queue")).toBe("queue");
    expect(followUpWhenBusy(false, "steer")).toBe("steer");
    expect(followUpWhenBusy(false, "queue")).toBe("queue");
    expect(blocksBusySend(true, "steer")).toBe(false);
    expect(blocksBusySend(true, "queue")).toBe(false);
    expect(blocksBusySend(false, "steer")).toBe(false);
    expect(blocksBusySend(false, "queue")).toBe(false);
  });

  it("shows the sentence once, on the queue when a message is waiting and beside the box only when send would steer", () => {
    const note = cantRedirectTurn("grok");
    expect(redirectNotePlace(note, true, true)).toBe("queue");
    expect(redirectNotePlace(note, true, false)).toBe("queue");
    expect(redirectNotePlace(note, false, true)).toBe("composer");
    expect(redirectNotePlace(note, false, false)).toBe("none");
    expect(redirectNotePlace(undefined, true, true)).toBe("none");
    expect(redirectNotePlace("  ", false, true)).toBe("none");
  });
});
