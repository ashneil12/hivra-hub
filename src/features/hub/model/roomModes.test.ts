// WP-22: the pure rules of responder modes and goal mode (roomModes.ts).
import { describe, expect, it, vi } from "vitest";
import {
  AUTO_PICK_TIMEOUT_MS,
  autoPick,
  autoPickPrompt,
  GOAL_MAX_TURNS,
  goalEndLine,
  goalTask,
  isResponderMode,
  mentionedSeats,
  parseAutoPick,
  parseGoalControl,
  responderOf,
} from "./roomModes";
import type { Seat } from "./roomTurns";

const SEATS: Seat[] = [
  { id: "ada", name: "Chief of Staff" },
  { id: "bo", name: "Projects Manager" },
  { id: "ed", name: "ed" },
];
const recent = [{ who: "Ash", text: "ed, did the decision about pricing make it into memory?" }];

describe("responder modes", () => {
  it("a room that never chose answers as before (everyone); only the four modes count", () => {
    expect(responderOf({})).toBe("everyone");
    expect(responderOf({ responder: "loudest" })).toBe("everyone");
    expect(responderOf({ responder: "auto" })).toBe("auto");
    expect(["lead", "mentions", "everyone", "auto"].every(isResponderMode)).toBe(true);
  });

  it("finds every seat Ash mentions, latest message first, each once", () => {
    expect(mentionedSeats(["@ed and @Projects Manager, check this"], SEATS).map((s) => s.id)).toEqual(["ed", "bo"]);
    expect(mentionedSeats(["hey @ed", "@ada what now"], SEATS).map((s) => s.id)).toEqual(["ada", "ed"]);
    expect(mentionedSeats(["ed, can you check?"], SEATS).map((s) => s.id)).toEqual(["ed"]);
    expect(mentionedSeats(["what's left this week?"], SEATS)).toEqual([]);
  });
});

describe("auto pick", () => {
  it("asks with the members' ids and roles and the latest messages", () => {
    const { system, prompt } = autoPickPrompt(SEATS, recent);
    expect(system).toMatch(/JSON only/);
    expect(prompt).toContain('id "ed"');
    expect(prompt).toContain("Ash: ed, did the decision");
  });

  it("reads one seat or several, by id or name; anything unsure or low in confidence is unsure", () => {
    expect(parseAutoPick('{"pick":["ed"],"confidence":0.9}', SEATS)).toEqual({ ids: ["ed"], confidence: 0.9 });
    expect(parseAutoPick('Sure: {"pick":["Projects Manager","ed"],"confidence":0.8}', SEATS)).toEqual({ ids: ["bo", "ed"], confidence: 0.8 });
    expect(parseAutoPick('{"pick":[],"confidence":0}', SEATS)).toEqual({ unsure: "unsure" });
    expect(parseAutoPick('{"pick":["ed"],"confidence":0.3}', SEATS)).toEqual({ unsure: "low confidence" });
    expect(parseAutoPick('{"pick":["nobody-here"],"confidence":0.9}', SEATS)).toEqual({ unsure: "unsure" });
    expect(parseAutoPick("ed should answer", SEATS)).toEqual({ unsure: "no answer" });
  });

  it("gives the decider's pick, marked as picked automatically", async () => {
    const decider = vi.fn(async () => '{"pick":["ed"],"confidence":0.95}');
    expect(await autoPick({ decider, seats: SEATS, recent })).toEqual({ ids: ["ed"], why: "picked automatically" });
    expect(decider.mock.calls[0][0]).toMatchObject({ timeoutMs: AUTO_PICK_TIMEOUT_MS });
  });

  it("falls back to the lead with no model, on an error, when unsure, on low confidence and on a timeout", async () => {
    expect(await autoPick({ decider: undefined, seats: SEATS, recent })).toEqual({ fallback: "no quick model is set up" });
    expect(await autoPick({ decider: () => Promise.reject(new Error("401")), seats: SEATS, recent })).toEqual({ fallback: "the quick pick failed" });
    expect(await autoPick({ decider: () => { throw new Error("sync"); }, seats: SEATS, recent })).toEqual({ fallback: "the quick pick failed" });
    expect(await autoPick({ decider: async () => '{"pick":[],"confidence":0}', seats: SEATS, recent })).toEqual({ fallback: "the quick pick was unsure" });
    expect(await autoPick({ decider: async () => '{"pick":["ed"],"confidence":0.2}', seats: SEATS, recent })).toEqual({ fallback: "the quick pick wasn't sure" });
    let aborted = false;
    const started = Date.now();
    const slow = await autoPick({
      decider: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => (aborted = true));
          setTimeout(() => resolve('{"pick":["ed"],"confidence":1}'), 5_000);
        }),
      seats: SEATS,
      recent,
      timeoutMs: 60,
    });
    expect(slow).toEqual({ fallback: "the quick pick took too long" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(aborted).toBe(true);
  });

  it("never waits past 1.5 seconds by default", () => {
    expect(AUTO_PICK_TIMEOUT_MS).toBe(1_500);
  });
});

describe("goal mode", () => {
  it("reads the lead's control block, takes it out of the post, and refuses a seat that isn't in the room", () => {
    const text = 'Plan agreed. PM owns the board.\n<room_control>{"status":"continue","next":"bo","instruction":"Put the three cards on the board."}</room_control>';
    expect(parseGoalControl(text, SEATS)).toEqual({
      post: "Plan agreed. PM owns the board.",
      control: { status: "continue", next: "bo", instruction: "Put the three cards on the board." },
    });
    expect(parseGoalControl('Done.\n<room_control>{"status":"needs input","reason":"Ash picks the price"}</room_control>', SEATS).control).toEqual({
      status: "needs_input",
      reason: "Ash picks the price",
    });
    expect(parseGoalControl('<room_control>{"status":"completed","reason":"all three shipped"}</room_control>', SEATS)).toEqual({
      post: "",
      control: { status: "completed", reason: "all three shipped" },
    });
    expect(parseGoalControl('x<room_control>{"status":"continue","next":"ghost"}</room_control>', SEATS)).toEqual({ post: "x" });
    expect(parseGoalControl("x<room_control>not json</room_control>", SEATS)).toEqual({ post: "x" });
    expect(parseGoalControl("no block at all", SEATS)).toEqual({ post: "no block at all" });
  });

  it("asks the lead to choose who goes next within the bound, and a member to do what it was asked", () => {
    const lead = SEATS[0];
    const leadTask = goalTask({ me: lead, lead, seats: SEATS, goal: "Ship the pricing page", turn: 3, max: GOAL_MAX_TURNS });
    expect(leadTask).toContain("turn 3 of at most 13");
    expect(leadTask).toContain("<room_control>");
    expect(leadTask).toContain('"ed" (ed)');
    const member = goalTask({ me: SEATS[2], lead, seats: SEATS, goal: "Ship the pricing page", turn: 4, max: GOAL_MAX_TURNS, instruction: "Check memory" });
    expect(member).toContain('Chief of Staff asked you: "Check memory"');
    expect(member).not.toContain("<room_control>");
  });

  it("says how a run ended in plain words", () => {
    expect(goalEndLine("completed", "all three shipped.")).toBe("Goal completed: all three shipped.");
    expect(goalEndLine("needs_input", "Ash picks the price")).toBe("Goal needs you: Ash picks the price.");
    expect(goalEndLine("blocked")).toBe("Goal blocked.");
    expect(GOAL_MAX_TURNS).toBe(13);
  });
});
