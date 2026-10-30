// r89 step 2 (s16 run 1, SCRIPTED): the Lead rolled up without testing, but the app's own run never came. The worker's
// row had been delivered and let go by the window, so the run waited on rows that were gone. The chat's own landed
// report is enough now; an old roll-up doesn't start one.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { hubTestRunDue } from "./projectTestRun";

const NOW = Date.UTC(2026, 9, 30, 10, 40);
const report = (id: string, startedAt?: number) =>
  ({
    id,
    role: "user",
    internal: true,
    startedAt,
    text: "[MonoCode report] … [MonoCode landed] The app put this worker's changes into the project (not committed): packages/ui/src/App.tsx.",
    monoSessionCompletion: { sessionId: "w", title: "Tally count at the top of the board", status: "completed" },
  }) as unknown as Block;
const said = (id: string, text: string) => ({ id, role: "assistant", text }) as Block;
const lead = (blocks: Block[]) => ({ id: "lead", cwd: "/Users/ash/Projects/tally", blocks }) as unknown as Session;

describe("the app's own test run when the job's row is gone", () => {
  it("is due from the chat's landed report alone", () => {
    const chat = lead([report("r1", NOW - 60_000), said("a1", "The count is in. I did not run tests.")]);
    expect(hubTestRunDue(chat, [], new Set(), NOW)).toEqual({ key: "hub-tests-r1", project: "/Users/ash/Projects/tally" });
  });

  it("is not due for an old roll-up", () => {
    const chat = lead([report("r1", NOW - 3 * 60 * 60 * 1000), said("a1", "The count is in.")]);
    expect(hubTestRunDue(chat, [], new Set(), NOW)).toBeUndefined();
  });

  it("a block with no id doesn't stop the check", () => {
    const chat = lead([report("r1", NOW - 60_000), { role: "system", text: "is back" } as Block, said("a1", "In.")]);
    expect(hubTestRunDue(chat, [], new Set(), NOW)?.key).toBe("hub-tests-r1");
  });
});
