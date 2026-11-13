// @vitest-environment happy-dom
// r85 (s14 r84 run 4): "Delete now keeps a tally for 30 days so you can undo it" came 6s after Ash answered, minutes
// before the worker built it. While the chat's own job is still out, a "now does X" or a done claim is checked once,
// and the check says to say it's under way, not to run the work itself.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAskStore } from "../../asks/model/askStore";
import { freshAskStore, sayInHub as recordAskText } from "../../asks/testbed/hubAsks";
import type { Block, Session } from "../../sessions/model/session";
import { nowClaimOf, type EvidenceSource } from "./askLedger";
import { settleAsks } from "./askSettle";
import type { HubCheck } from "./hubChecks";

// The ask is in the one ask ledger, written the way the app writes a hub chat's asks (asks/model/hubRoute.ts).
beforeEach(() => {
  localStorage.clear();
  freshAskStore();
});
afterEach(() => setAskStore(undefined));

const block = (id: string, role: "user" | "assistant", text: string) => ({ id, role, text }) as Block;
const session = (blocks: Block[]) => ({ id: "lead", blocks, busy: false, cwd: "/tmp/nowhere" }) as unknown as Session;
const source: EvidenceSource = { commits: async () => [], commitFiles: async () => [], botChanges: () => [] };
const ASK = "can someone add delete for tallies, ive got a bunch of junk ones";

describe("a 'now does X' before its job lands", () => {
  it("finds the claim, and not a job that is moving or a plan", () => {
    expect(nowClaimOf("You chose 30 days. Delete now keeps a tally for 30 days so you can undo it.")).toBe("Delete now keeps a tally for 30 days so you can undo it.");
    expect(nowClaimOf("Saving that; the job now carries on from your words.")).toBeUndefined();
    expect(nowClaimOf("The worker is now running the tests.")).toBeUndefined();
    expect(nowClaimOf("I'll now hand it to a worker.")).toBeUndefined();
    expect(nowClaimOf("Delete still doesn't keep anything yet.")).toBeUndefined();
  });

  it("checks it once while the chat's job is out, asking it to say it's under way", async () => {
    await recordAskText("lead", "u1", ASK, Date.now() - 60_000);
    const chat = session([block("u1", "user", ASK), block("a1", "assistant", "Delete now keeps a tally for 30 days so you can undo it.")]);
    const offered: HubCheck[] = [];
    await settleAsks([chat], source, (checks) => offered.push(...checks), { openJobs: () => ["Delete tallies"] });
    expect(offered).toHaveLength(1);
    expect(offered[0].id).toBe("dc-u1-early");
    expect(offered[0].prompt).toContain('"Delete tallies" is still being built');
    expect(offered[0].prompt).toContain("under way, not in yet");
    // r99: said plainly, without the checker's "Right:" / "Fixed:" label.
    expect(offered[0].prompt).not.toContain('starting "Right:" or "Fixed:"');
    expect(offered[0].prompt).toContain("one plain line");
    await settleAsks([chat], source, (checks) => offered.push(...checks), { openJobs: () => ["Delete tallies"] });
    expect(offered).toHaveLength(1);
  });

  it("leaves it alone once no job is out", async () => {
    await recordAskText("lead", "u1", ASK, Date.now() - 60_000);
    const chat = session([block("u1", "user", ASK), block("a1", "assistant", "Delete now keeps a tally for 30 days so you can undo it.")]);
    const offered: HubCheck[] = [];
    await settleAsks([chat], source, (checks) => offered.push(...checks), { openJobs: () => [] });
    expect(offered).toEqual([]);
  });
});
