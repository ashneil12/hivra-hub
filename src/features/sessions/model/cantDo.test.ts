import { describe, expect, it } from "vitest";
import {
  COMPACTING_NOTE,
  QUEUED_MESSAGE_WAITS,
  cantRedirectTurn,
  cantTakeFollowUp,
  followUpWhenBusy,
  redirectNotePlace,
  type BusyFollowUpInput,
} from "./cantDo";

const DASH = /[—–]/;

/** A plain chat on an agent that can redirect, with the setting on steer. */
function busy(patch: Partial<BusyFollowUpInput> = {}) {
  return followUpWhenBusy({
    setting: "steer",
    mustWait: false,
    onlyBackgroundWork: false,
    mono: false,
    steerable: true,
    cannotRedirect: false,
    compacting: false,
    alreadyQueued: false,
    ...patch,
  });
}

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
    // The setting asks for steer. A CLI that cannot redirect queues instead.
    expect(busy({ cannotRedirect: true })).toBe("queue");
    expect(busy({ cannotRedirect: true, setting: "queue" })).toBe("queue");
    // The same turn on an agent that can redirect still steers.
    expect(busy({ cannotRedirect: false })).toBe("steer");
    expect(busy({ cannotRedirect: false, setting: "queue" })).toBe("queue");
    // Even when only background work is left, which would otherwise hand it over now.
    expect(busy({ cannotRedirect: true, onlyBackgroundWork: true })).toBe("queue");
  });

  it("queues a message sent while the app compacts the chat, so it never lands inside the compact", () => {
    expect(busy({ compacting: true, steerable: false })).toBe("queue");
    expect(busy({ compacting: true, steerable: false, mono: true })).toBe("queue");
    expect(busy({ compacting: false })).toBe("steer");
  });

  it("keeps the rules that existed before: waits, background work, a Mono", () => {
    expect(busy({ mustWait: true })).toBe("queue");
    expect(busy({ onlyBackgroundWork: true, setting: "queue" })).toBe("steer");
    expect(busy({ mono: true, steerable: true, setting: "queue" })).toBe("steer");
    expect(busy({ mono: true, steerable: false })).toBe("queue");
  });

  it("never queues a queued message a second time", () => {
    // Its own Steer button. Steered when it can be, refused by the caller when this agent cannot take one.
    expect(busy({ alreadyQueued: true, cannotRedirect: true })).toBe("steer");
    expect(busy({ alreadyQueued: true, compacting: true, steerable: false })).toBe("steer");
    expect(busy({ alreadyQueued: true })).toBe("steer");
    // A message that has to wait for an idle chat stays where it is, however it got there.
    expect(busy({ alreadyQueued: true, mustWait: true })).toBe("stay");
    expect(busy({ alreadyQueued: true, mustWait: true, cannotRedirect: true })).toBe("stay");
    expect(busy({ alreadyQueued: true, setting: "queue" })).toBe("stay");
    // And a new message that has to wait is queued once.
    expect(busy({ mustWait: true })).toBe("queue");
  });

  it("says what is going on while the app compacts, without a dash", () => {
    expect(COMPACTING_NOTE).toBe("Compacting this chat while it's idle. A message you send now waits until that finishes.");
    expect(COMPACTING_NOTE).not.toMatch(DASH);
    expect(QUEUED_MESSAGE_WAITS).not.toMatch(DASH);
    // Beside the box with nothing queued, on the queue (instead of Steer) when a message waits.
    expect(redirectNotePlace(COMPACTING_NOTE, false, true)).toBe("composer");
    expect(redirectNotePlace(COMPACTING_NOTE, true, true)).toBe("queue");
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
