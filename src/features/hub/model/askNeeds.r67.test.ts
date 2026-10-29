// r67 (Critiquito on r66): the five top asks were grey while the project badges said 5. Existing asks are classified on
// read: every open ask the badge counts reads red "Needs you", with the reason the new asks' list gives.
import { describe, expect, it } from "vitest";
import { needMark } from "../ui/StatusMark";
import { askNeedsAsh, askReason } from "./askNeeds";
import type { Need } from "./types";

const ask = (title: string, why = "My suggestion: …", extra: Partial<Need> = {}): Need => ({
  id: `q:${title.slice(0, 8)}`, projectId: "hub", title, why, actionType: "see_options" as Need["actionType"],
  actionLabel: "See options", actionTarget: `question:${title.slice(0, 8)}`, state: "open", ...extra,
});

// The five rows on Critiquito's crit-2-inbox.png, in order.
const FIVE = [
  ask("Which parts of your game-building studio should move into Monocode, and which should stay where they are?"),
  ask("Which service is it, and does its giveaway allow one person to claim with 50 separate wallets?"),
  ask("Can you sign in to your Grok subscription so agents can use it for Grok models?"),
  ask("Can you switch remote control on for all your sessions yourself, since it's an account setting I can't change?"),
  ask("Can you log into X in the browser yourself so an agent can scroll and read your bookmarks?"),
];

describe("existing asks follow the red rule", () => {
  it("the five shown asks the badge counts all read red Needs you, so the red rows match the badge of 5", () => {
    const marks = FIVE.map((n) => needMark(n, true));
    expect(marks.every((m) => m?.circle === "red" && m.word === "Needs you")).toBe(true);
    expect(FIVE.filter((n) => askNeedsAsh(n, true)).length).toBe(5);
  });

  it("each gets its reason from the same list the new asks use", () => {
    expect(FIVE.map(askReason)).toEqual(["pick an option", "pick an option", "sign in", "provide something", "sign in"]);
  });

  it("rows the badge doesn't count stay grey: under Later, ticked off, or not an ask at all", () => {
    expect(needMark(FIVE[2], false)).toBeNull();
    expect(needMark({ ...FIVE[2], state: "done" }, true)).toBeNull();
    expect(needMark({ ...FIVE[2], actionTarget: undefined }, true)).toBeNull();
    // A job's own red stays as it was.
    expect(needMark({ circle: "red", word: "Needs you", jobId: "j_1" })).toMatchObject({ circle: "red" });
  });
});
