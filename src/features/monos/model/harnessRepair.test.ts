// Harness self-repair (board H1/H3): a chat's own failed turn is tried twice by the app, then said once and left alone.
import { describe, expect, it } from "vitest";
import {
  autoRepairable,
  faultOf,
  HarnessRepair,
  HARNESS_BACKOFF_MS,
  HARNESS_RESET_MS,
  HARNESS_STALE_MS,
  type HarnessFault,
} from "./harnessRepair";

const T = Date.UTC(2026, 9, 22, 9);
const MIN = 60_000;

const fault = (over: Partial<HarnessFault> = {}): HarnessFault => ({
  sessionId: "s-1",
  blockId: "b-1",
  reason: "The model's API failed",
  retryable: true,
  seenAt: T,
  ...over,
});

function bench() {
  let now = T;
  const retried: string[] = [];
  const notes: { session: string; text: string }[] = [];
  const repair = new HarnessRepair({
    now: () => now,
    retry: (id) => {
      retried.push(id);
      return true;
    },
    note: (id, message) => {
      notes.push({ session: id, text: message.text });
    },
  });
  return { repair, retried, notes, at: (t: number) => (now = t) };
}

describe("retrying a chat's own failed turn", () => {
  it("tries twice with backoff, then says once, plainly, and stops", () => {
    const { repair, retried, notes, at } = bench();
    repair.tick([fault()]);
    expect(retried).toEqual([]); // A fault waits a minute before its first try.
    at(T + HARNESS_BACKOFF_MS[0]);
    repair.tick([fault()]);
    expect(retried).toEqual(["s-1"]);
    expect(repair.state("s-1")).toMatchObject({ tries: 1 });
    at(T + HARNESS_BACKOFF_MS[0] + HARNESS_BACKOFF_MS[1]);
    repair.tick([fault()]);
    expect(retried).toEqual(["s-1", "s-1"]);
    expect(notes).toEqual([]);
    at(T + 20 * MIN);
    repair.tick([fault()]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ session: "s-1" });
    expect(notes[0].text).toContain("The model's API failed");
    expect(notes[0].text).toContain("won't retry by itself again");
    expect(notes[0].text).toContain("[MonoCode self-repair]");
    expect(notes[0].text).toContain("this is the app, not Ash");
    at(T + 40 * MIN);
    repair.tick([fault()]);
    expect(retried).toHaveLength(2);
    expect(notes).toHaveLength(1);
  });

  it("counts a new failed turn in the same chat against the same tries, so a loop can't retry for ever", () => {
    const { repair, retried, at } = bench();
    at(T + HARNESS_BACKOFF_MS[0]);
    repair.tick([fault()]);
    expect(retried).toHaveLength(1);
    at(T + 90_000);
    repair.tick([fault({ blockId: "b-2" })]);
    expect(retried).toHaveLength(1);
    expect(repair.state("s-1")).toMatchObject({ episode: "b-2", tries: 1 });
    at(T + 7 * MIN);
    repair.tick([fault({ blockId: "b-2" })]);
    expect(retried).toHaveLength(2);
  });

  it("starts a later fault with fresh tries once the chat has run cleanly for half an hour", () => {
    const { repair, retried, at } = bench();
    at(T + HARNESS_BACKOFF_MS[0]);
    repair.tick([fault()]);
    at(T + 6 * MIN);
    repair.tick([]);
    at(T + 6 * MIN + HARNESS_RESET_MS - MIN);
    repair.tick([]);
    expect(repair.state("s-1")).toBeDefined();
    at(T + 6 * MIN + HARNESS_RESET_MS + MIN);
    repair.tick([]);
    expect(repair.state("s-1")).toBeUndefined();
    expect(retried).toHaveLength(1);
  });

  it("never replays a failure from hours ago (a restart is not a reason to re-run a turn)", () => {
    const { repair, retried, notes, at } = bench();
    at(T + HARNESS_STALE_MS + MIN);
    repair.tick([fault()]);
    repair.tick([fault()]);
    expect(retried).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe("what the app may retry by itself", () => {
  it("is a passing fault, never a refusal, a limit or a person's decision", () => {
    expect(autoRepairable(fault())).toBe(true);
    expect(autoRepairable(fault({ errorClass: "overloaded" }))).toBe(true);
    expect(autoRepairable(fault({ retryable: false }))).toBe(false);
    expect(autoRepairable(fault({ errorClass: "auth" }))).toBe(false);
    expect(autoRepairable(fault({ errorClass: "billing" }))).toBe(false);
    expect(autoRepairable(fault({ errorClass: "usage_limit" }))).toBe(false);
    expect(autoRepairable(fault({ resetsAt: T + 60 * MIN }))).toBe(false);
    expect(autoRepairable(fault({ reason: "Out of credits" }))).toBe(false);
    expect(autoRepairable(fault({ reason: "Signed out of the model" }))).toBe(false);
  });

  it("leaves a refused chat to its own failure card: no retry and no note", () => {
    const { repair, retried, notes, at } = bench();
    at(T + 20 * MIN);
    repair.tick([fault({ errorClass: "auth", retryable: false, reason: "Sign-in refused" })]);
    expect(retried).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe("reading a chat's failure", () => {
  it("takes the failed turn as the chat records it", () => {
    const session = {
      id: "s-1",
      busy: false,
      blocks: [
        { id: "b-1", role: "user", text: "Fix the save bug" },
        {
          id: "b-9",
          role: "system",
          notice: "error",
          text: "API Error: 529 overloaded",
          failure: { errorClass: "overloaded", retryable: true, at: T },
        },
      ],
    } as never;
    expect(faultOf(session, T)).toMatchObject({
      sessionId: "s-1",
      blockId: "b-9",
      errorClass: "overloaded",
      retryable: true,
      reason: "The model is overloaded",
    });
    expect(faultOf({ ...(session as object), busy: true } as never, T)).toBeUndefined();
  });
});
