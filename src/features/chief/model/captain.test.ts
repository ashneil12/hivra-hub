import { describe, expect, it } from "vitest";
import {
  HOUR_MS,
  PASS_UP_MS,
  TURN_CAP,
  captainAnswerHeld,
  captainDecide,
  claimTurn,
  isOwnerKey,
  passUpDue,
  raiseBudget,
  raiseCap,
  suggestLine,
  type CaptainQuestion,
} from "./captain";

const NOW = 1_700_000_000_000;

function ask(over: Partial<CaptainQuestion> = {}): CaptainQuestion {
  return {
    project: "hivra",
    monoId: "ada",
    question: "Example: which name?",
    options: ["Example: keep it", "Example: change it"],
    recommendation: "Example: change it",
    switchOn: true,
    now: NOW,
    ...over,
  };
}

describe("the captain's order", () => {
  it("stops at the first step that applies, and an earlier step wins", () => {
    const standing = { answer: "Example: keep it", label: "merge on green" };
    const learned = { answer: "Example: change it", label: "last time" };
    const rules = [{ when: "which name", answer: "Example: keep it" }];
    const confident = { confident: true, why: "retry once", standing, learned, rules };

    const ruled = captainDecide(ask(confident));
    expect(ruled.kind === "answer" && ruled.step).toBe(2);

    const noRule = captainDecide(ask({ ...confident, rules: [] }));
    expect(noRule).toMatchObject({ step: 3, answer: "Example: keep it", reason: "standing answer: merge on green", answeredBy: "captain:ada" });

    const learnedOnly = captainDecide(ask({ confident: true, why: "retry once", learned, standing: null }));
    expect(learnedOnly.kind === "answer" && learnedOnly.step).toBe(4);
    expect(captainDecide(ask({ confident: true, why: "retry once" }))).toMatchObject({
      step: 5,
      answer: "Example: change it",
      reason: "The first mate was confident: retry once",
    });
    expect(captainDecide(ask({ confident: true, why: "retry once", department: "Docs" }))).toMatchObject({
      reason: "Docs was confident: retry once",
    });
    expect(captainDecide(ask({ confident: true, why: "retry once", department: "  " })).reason).toBe(
      "The first mate was confident: retry once",
    );

    let called = false;
    const turned = captainDecide(
      ask({
        recommendation: undefined,
        turn: () => {
          called = true;
          return { pick: "Example: keep it", reason: "shorter" };
        },
      }),
    );
    expect(called).toBe(true);
    expect(turned).toMatchObject({ step: 6, reason: "captain turn: shorter", recordTurn: true });
  });

  it("passes a red line and a person-only key up even when a standing answer or a confident pick would answer", () => {
    const later = {
      confident: true,
      why: "retry once",
      standing: { answer: "Refund it", label: "merge on green" },
      rules: [{ when: "refund", answer: "Refund it" }],
    };
    expect(captainDecide(ask({ question: "Refund the second charge?", options: ["Refund it", "Leave it"], ...later })).kind).toBe("ask-owner");
    expect(
      captainDecide(
        ask({
          decisionKey: "Ｓecret/token",
          question: "Example: which name?",
          ...later,
          standing: { answer: "Example: keep it", label: "merge on green" },
        }),
      ),
    ).toMatchObject({ kind: "ask-owner", reason: "This one is only the owner's." });
    expect(captainDecide(ask({ decisionKey: "fresh-eyes/run", ...later, standing: { answer: "Example: keep it", label: "x" } })).kind).toBe("ask-owner");
    expect(isOwnerKey("security-review/run")).toBe(true);
    expect(captainDecide(ask({ decisionKey: "security-review/run", ...later, standing: { answer: "Example: keep it", label: "x" } })).kind).toBe(
      "ask-owner",
    );
    expect(captainDecide(ask({ moneyOverLimit: true, ...later, standing: { answer: "Example: keep it", label: "x" } }))).toMatchObject({
      kind: "ask-owner",
      reason: "Money is past the owner's limit.",
    });
    expect(captainDecide(ask({ question: "Should I publish the release notes?", options: ["Yes", "No"], recommendation: "Yes", confident: true })).kind).toBe(
      "ask-owner",
    );
  });

  it("does nothing with an empty learned table, and the switch off never answers", () => {
    const turned = captainDecide(ask({ learned: null, recommendation: undefined, turn: () => ({ pick: "Example: keep it", reason: "ok" }) }));
    expect(turned.kind === "answer" && turned.step).toBe(6);
    expect(captainDecide(ask({ switchOn: false, confident: true, standing: { answer: "Example: keep it", label: "x" } }))).toMatchObject({
      kind: "ask-owner",
      reason: "The switch is off.",
    });
  });

  it("passes the 21st turn up, on an injectable clock", () => {
    const turns = Array.from({ length: TURN_CAP }, (_, index) => NOW - index * 1000);
    let called = false;
    const capped = captainDecide(
      ask({
        recommendation: undefined,
        turns,
        turn: () => {
          called = true;
          return { pick: "Example: keep it", reason: "again" };
        },
      }),
    );
    expect(called).toBe(false);
    expect(capped).toMatchObject({ kind: "ask-owner", reason: "The captain is out of turns this hour." });
    // A turn from more than an hour ago does not count.
    const room = captainDecide(
      ask({
        recommendation: undefined,
        turns: [NOW - HOUR_MS - 1],
        turn: () => ({ pick: "Example: keep it", reason: "ok" }),
      }),
    );
    expect(room.kind === "answer" && room.step).toBe(6);
  });

  it("passes up once after 10 minutes, and not before", () => {
    let called = false;
    const waiting = captainDecide(ask({ recommendation: undefined, pendingSince: NOW }));
    expect(waiting.kind).toBe("waiting");
    const late = captainDecide(
      ask({
        recommendation: "Example: keep it",
        pendingSince: NOW - PASS_UP_MS,
        turn: () => {
          called = true;
          return { pick: "Example: keep it", reason: "too late" };
        },
      }),
    );
    expect(called).toBe(false);
    expect(late).toMatchObject({ kind: "ask-owner", line: suggestLine("Example: keep it") });

    const pending = [{ id: "q1", since: NOW - PASS_UP_MS }, { id: "q1", since: NOW - PASS_UP_MS }, { id: "q2", since: NOW }];
    expect(passUpDue(pending, NOW)).toEqual(["q1"]);
    const left = pending.filter((row) => row.id !== "q1");
    expect(passUpDue(left, NOW)).toEqual([]);
  });

  it("cannot raise its own turn cap or a budget", () => {
    expect(() => raiseCap()).toThrow(/cannot raise its own turn cap/);
    expect(() => raiseBudget()).toThrow(/cannot raise a budget/);
    const ledger = { turns: [] as number[] };
    for (let n = 0; n < TURN_CAP; n += 1) expect(claimTurn(ledger, NOW)).toBe(true);
    expect(claimTurn(ledger, NOW)).toBe(false);
    expect(ledger.turns).toHaveLength(TURN_CAP);
  });

  it("refuses a step-6 pick that is not one of the options", () => {
    const result = captainDecide(ask({ recommendation: undefined, turn: () => ({ pick: "something else", reason: "no" }) }));
    expect(result.kind).toBe("ask-owner");
  });

  it("holds a pass-up and retries a delivery that did not land", () => {
    expect(captainAnswerHeld("Chief of Staff suggests: Example: retry once")).toBe(true);
    expect(captainAnswerHeld("The captain is out of turns this hour.")).toBe(true);
    expect(captainAnswerHeld("This one is only the owner's.")).toBe(true);
    expect(captainAnswerHeld("couldn't take a message")).toBe(false);
    expect(captainAnswerHeld("the app couldn't answer this one")).toBe(false);
  });
});
