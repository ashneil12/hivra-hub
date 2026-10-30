import { describe, expect, it } from "vitest";
import { serviceStallLine } from "./workerStuck";
import { stoppedLine } from "./stuckFold";
import { STALLED } from "../../hub/model/statusChip";

describe("r91 (Critiquito): one plain word and line for a stalled worker", () => {
  it("says what happened in Ash's words, no codes, no API", () => {
    const line = serviceStallLine("API retry 2 of 2 · API overloaded (529)");
    expect(line).toBe("Stalled: the AI service is overloaded and stopped answering. Retrying didn't help.");
    expect(line).not.toMatch(/529|API|provider/);
    expect(serviceStallLine("no progress for 60s")).toBe("Stalled: the AI service stopped answering.");
  });
  it("is Stalled on the chip and the fold", () => {
    expect(STALLED.word).toBe("Stalled");
    expect(stoppedLine(1, 1)).toMatch(/1 worker stalled/);
  });
});

import type { Delegation } from "./delegations";
import type { StuckWorker } from "./workerStuck";
import { appSinceText } from "../../hub/model/appSince";

describe("r91: Inbox says '1 has stalled', once", () => {
  it("names a stalled worker under its own count, not 'with its Lead'", () => {
    const SINCE = 1_000_000_000;
    const r = { id: "s", title: "Show tally count at the top", state: "running", updatedAt: SINCE + 10, createdAt: SINCE - 10, settledAt: null } as unknown as Delegation;
    const s: StuckWorker = { row: r, kind: "stalled", line: "", since: SINCE + 10, escalated: false, key: "s" } as StuckWorker;
    const text = appSinceText({ sinceMs: SINCE, rows: [r], stuck: [s], changes: [], nameOf: () => "Tally lead",
      jobs: [{ title: "Show tally count at the top", failed: false, at: SINCE + 20 }] });
    expect(text).toContain("1 has stalled: Show tally count at the top.");
    expect(text).not.toMatch(/with its Lead or waiting/);
  });
});
