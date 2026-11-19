// @vitest-environment happy-dom
// WP-176 round 3 (#217), H1. submitSession ends in sendHarnessTurn and steerHarnessTurn, and a habit or agent-app caller
// reaches them with no origin, so it is automated; only the composer's turn is "person". These tests drive those two
// entry points the way submitSession does, red on the round 2 head where the origin was never passed through.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSpendGate,
  saveSpendLimit,
  setSpendProjectLookup,
  setSpendRecords,
  setSpendClock,
  setSpendWarnSink,
} from "../../../features/usage/model/spendGate";
import { generateHarnessCommitMessage, registerHarness, resetHarnessIdlePark, runHarnessTextPrompt, sendHarnessTurn, steerHarnessTurn, type HarnessAdapter } from "./registry";
import type { SendTurnInput, SteerTurnInput } from "./types";

const now = Date.parse("2026-11-10T15:00:00");
const FOLDER = "/work/monocode-hub";

let generatedCommits = 0;

function stub(sent: string[], steered: string[]): HarnessAdapter {
  return {
    id: "claude",
    live: true,
    async sendTurn(input: SendTurnInput) {
      sent.push(input.text);
    },
    async steerTurn(input: SteerTurnInput) {
      steered.push(input.text);
    },
    async cancelTurn() {},
    respondApproval() {},
    async stopSession() {},
    async forgetSession() {},
    bindSession() {},
    async runTextPrompt() {
      return "ok";
    },
    async generateCommitMessage() {
      generatedCommits += 1;
      return "feat: change";
    },
  } as HarnessAdapter;
}

/** The app-wide limit is spent: the next billed turn is over it. */
function overTheLimit() {
  setSpendProjectLookup({ idOf: () => undefined, folderOf: () => undefined });
  setSpendRecords([{ projectKey: FOLDER, sessionId: "earlier", day: "2026-11-10", micros: 50_000_000, priced: 1, unpriced: 0 }]);
  saveSpendLimit({ scope: "app", period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
}

describe("H1: the turns submitSession sends pass the spend gate by their origin", () => {
  const sent: string[] = [];
  const steered: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    steered.length = 0;
    resetSpendGate();
    setSpendClock(() => now);
    setSpendWarnSink({ wake: async () => ({ fresh: true }), activity: () => undefined });
    registerHarness(stub(sent, steered));
    overTheLimit();
  });
  afterEach(() => {
    resetHarnessIdlePark();
    vi.useRealTimers();
  });

  it("a habit or agent-app turn (no origin) over the limit is refused and starts nothing", async () => {
    await expect(sendHarnessTurn({ harness: "claude", sessionId: "habit-run", cwd: FOLDER, model: "custom:acme", text: "run", origin: undefined } as never)).rejects.toThrow(/limit/i);
    expect(sent).toEqual([]);
  });

  it("the composer's own turn over the limit is admitted, with a warning rather than a refusal", async () => {
    await sendHarnessTurn({ harness: "claude", sessionId: "composer", cwd: FOLDER, model: "custom:acme", text: "hi", origin: "person" } as never);
    expect(sent).toEqual(["hi"]);
  });

  it("an automated steer over the limit is refused, and the composer's own steer is admitted", async () => {
    await expect(steerHarnessTurn({ harness: "claude", sessionId: "habit-run", cwd: FOLDER, model: "custom:acme", text: "nudge" } as never)).rejects.toThrow(/limit/i);
    await steerHarnessTurn({ harness: "claude", sessionId: "composer", cwd: FOLDER, model: "custom:acme", text: "steer", origin: "person" } as never);
    expect(steered).toEqual(["steer"]);
  });

  it("a commit message is automated text work: refused over the limit before the adapter runs", async () => {
    generatedCommits = 0;
    await expect(generateHarnessCommitMessage("claude", FOLDER)).rejects.toThrow(/limit/i);
    expect(generatedCommits).toBe(0);
  });

  it("a commit message Ash asks for is a person's turn: warned, not refused, over the limit", async () => {
    generatedCommits = 0;
    await expect(generateHarnessCommitMessage("claude", FOLDER, undefined, undefined, "person")).resolves.toBe("feat: change");
    expect(generatedCommits).toBe(1);
  });

  it("a text prompt (a title, a memory pass) is automated work: refused over the limit", async () => {
    await expect(runHarnessTextPrompt({ harness: "claude", cwd: FOLDER, model: "custom:acme", prompt: "title?" } as never)).rejects.toThrow(/limit/i);
  });
});
