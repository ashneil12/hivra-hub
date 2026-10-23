// H1 proof: a working day with Grok disabled. Ash's message is captured word for word and its chat writes his asks down;
// a delegated worker runs past the hour with only talk to show for it, and self-repair nudges it, stops and continues it,
// then tells its Lead once, with the stall watcher writing that verdict on the row; harness care pauses a pull request
// watch whose reads keep failing, continues a chat the app stopped resuming, cancels delegated work whose chat is gone —
// each leaving a Bot changes row — and tells once about a database that fails its own health check; a chat's own failed
// turn is retried by the app twice and then left alone; and a done claim waits for evidence in the real ledger. The real
// Ash OS backend (exo-cc-studio HEAD, on a throwaway ledger) and the app's real care classes on a fake clock: no model
// and no Grok bot anywhere in the day. Opt-in, since it needs python3 and the exo-cc-studio checkout:
//   HUB_PROOF=1 npx vitest run src/features/hub/proof/selfCareDay.proof.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_SHIP } from "../../../app/model/ship";
import { careFaults } from "../../monos/model/careFaults";
import { HarnessCare, SAFE_FIXES } from "../../monos/model/harnessCare";
import { faultOf, HarnessRepair } from "../../monos/model/harnessRepair";
import { tallyTranscript } from "../../monos/model/progressCheck";
import { SelfRepair } from "../../monos/model/selfRepair";
import { judgeWorkerProgress } from "../../monos/model/workerProgress";
import { STALL_DEFAULTS, StallWatch } from "../../monos/model/workerStall";
import type { Delegation, DelegationTracker } from "../../monos/model/delegations";
import type { PrWatch } from "../../pr-watch/model/prWatches";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
// @ts-expect-error plain .mjs helper
import { startIsolatedAshOs } from "../../../../scripts/proof/ashosIsolated.mjs";

const on = !!process.env.HUB_PROOF;
const log = (...a: unknown[]) => console.log("[proof-h1]", ...a);
const T = Date.UTC(2026, 9, 23, 7);
const MIN = 60_000;

type Service = {
  base: string;
  token: string;
  ready: { ashos_head: string };
  state(): Promise<{ models_called: number; ashos_head: string }>;
  stop(): Promise<void>;
};

const chat = (id: string, over: Partial<Session> = {}): Session => ({ id, blocks: [], ...over }) as unknown as Session;

const delegation = (over: Partial<Delegation>): Delegation =>
  ({
    id: "d-1",
    ownerSession: "lead-1",
    childSession: "worker-1",
    project: null,
    title: "Fix the save bug",
    state: "running",
    follow: null,
    createdAt: T,
    updatedAt: T,
    settledAt: null,
    ...over,
  }) as unknown as Delegation;

const block = (id: string, role: Block["role"], text: string, over: Partial<Block> = {}): Block =>
  ({ id, role, text, ...over }) as Block;

describe.skipIf(!on)("H1: a working day with Grok disabled", () => {
  let svc: Service;
  beforeAll(async () => {
    svc = await startIsolatedAshOs({ port: 18912, dev: true });
    log("Ash OS backend from exo-cc-studio", svc.ready.ashos_head, "on a throwaway ledger");
  }, 40_000);
  afterAll(async () => svc && svc.stop());

  /** Proof only: Ash's side of the day through the real AshOS methods (scripts/proof/ashos-isolated.py). */
  const act = async (action: string, value: Record<string, unknown> = {}) => {
    const response = await fetch(`${svc.base}/__proof/act`, { method: "POST", body: JSON.stringify({ action, value }) });
    const body = (await response.json()) as { ok: boolean; result?: any; error?: string };
    return body;
  };

  it("takes Ash's message, writes its asks down, and holds a done claim until there is evidence", async () => {
    const words = "Fix the save bug today, then check the exports after lunch.";
    const dump = await act("dump", { text: words, source: "proof", session: "proof-chat" });
    expect(dump.ok).toBe(true);
    const dumpId = String(dump.result!.dump_id);
    expect(dumpId).toBeTruthy();

    const recorded = await act("record", {
      dump_id: dumpId,
      session: "proof-chat",
      asks: [
        { title: "Fix the save bug", quote: "Fix the save bug today" },
        { title: "Check the exports", quote: "check the exports after lunch" },
      ],
    });
    expect(recorded.ok).toBe(true);
    const asks = recorded.result!.asks as Array<{ id: string; title: string }>;
    expect(asks.map((ask) => ask.title)).toEqual(["Fix the save bug", "Check the exports"]);
    const askId = asks[0].id;
    log("dump ->", asks.length, "asks");

    // The claim with nothing behind it: the ledger keeps the ask where it was.
    const claimed = await act("update-ask", { ask_id: askId, status: "done", session: "proof-chat" });
    expect(claimed).toMatchObject({ ok: false });
    expect(claimed.error).toContain("Add evidence to mark it done");
    const listed = (await act("asks", {})) as { result?: Array<{ id: string; status: string }> };
    expect(listed.result!.find((ask) => ask.id === askId)!.status).not.toBe("done");

    // Nor may an agent accept it for him.
    const accepted = await act("update-ask", { ask_id: askId, status: "accepted", session: "proof-chat" });
    expect(accepted).toMatchObject({ ok: false });
    expect(accepted.error).toContain("Only Ash accepts work");

    // With the check and its result, done is the chat's to say.
    const done = await act("update-ask", {
      ask_id: askId,
      status: "done",
      evidence: "npx vitest run src/features/monos/model/save.test.ts — 4 passed; commit r55proof",
      session: "proof-chat",
    });
    expect(done).toMatchObject({ ok: true, result: { status: "done" } });
    expect((await svc.state()).models_called).toBe(0);
  }, 30_000);

  it("carries a stalled worker through the hour on its own: nudge, restart, continue, then one plain word to its Lead", async () => {
    let now = T;
    const worker = chat("worker-1", {
      busy: true,
      blocks: [block("u-1", "user", "Fix the save bug"), block("a-1", "assistant", "Looking at the save path now.")],
    });
    const row = delegation({ createdAt: T - 70 * MIN, updatedAt: T - 70 * MIN });
    const stalls: Array<{ id: string; stall: unknown }> = [];
    const tracker = {
      isLoaded: () => true,
      known: () => [row],
      row: (id: string) => (id === row.id ? row : undefined),
      setStall: (entry: Pick<Delegation, "id">, stall: unknown) => {
        stalls.push({ id: entry.id, stall });
        return Promise.resolve({ applied: true, row: null });
      },
    } as unknown as DelegationTracker;
    const said: string[] = [];
    const leadNotes: string[] = [];
    let stops = 0;
    const repair = new SelfRepair({
      now: () => now,
      tracker: () => tracker,
      session: (id) => (id === worker.id ? worker : undefined),
      tellLead: (_row, text) => {
        leadNotes.push(text);
      },
      message: async (_row, text) => {
        said.push(text);
        return true;
      },
      stopTurn: async () => {
        stops += 1;
        return true;
      },
      reading: async () =>
        judgeWorkerProgress({
          look: { tally: tallyTranscript(worker.blocks), folder: null },
          report: "Looking at the save path now.",
          minutes: 70,
        }),
    });
    const watch = new StallWatch({
      now: () => now,
      tracker: () => tracker,
      session: (id) => (id === worker.id ? worker : undefined),
      openOwned: () => 0,
      options: () => STALL_DEFAULTS,
      hourly: (entry) => repair.stallFor(entry),
    });
    const look = async () => {
      await repair.tick();
      watch.tick();
    };

    await look(); // The first look only notes the row; it hasn't failed yet.
    expect(said).toEqual([]);
    now = T + MIN;
    await look();
    expect(said[0]).toContain("an hour in, this work isn't moving");
    now = T + 6 * MIN;
    await look();
    expect(stops).toBe(1);
    worker.busy = false;
    now = T + 7 * MIN;
    await look();
    expect(said.at(-1)).toBe("Continue from where you left off.");
    now = T + 21 * MIN;
    await look();
    now = T + 36 * MIN;
    await look();

    expect(leadNotes).toHaveLength(1);
    expect(leadNotes[0]).toContain("retries ran out");
    expect(repair.stallFor(row)).toMatchObject({ kind: "quiet", final: true });
    expect(stalls.at(-1)).toMatchObject({ id: "d-1", stall: { kind: "quiet", final: true } });
    log("worker: nudge, restart, continue, continue -> Lead told once; stall row", stalls.at(-1)?.stall);
    expect((await svc.state()).models_called).toBe(0);
  });

  it("fixes what care can see and says once what it can't, leaving a Bot changes row for each fix", async () => {
    let now = T;
    const worker = chat("worker-1", { busy: true });
    const stopped = chat("c-9", {
      blocks: [block("b-1", "system", "The app stopped resuming this turn.", { notice: "resume-stopped" })],
    });
    const rows = [
      delegation({ id: "d-1", childSession: "worker-1", updatedAt: T }),
      delegation({ id: "d-2", childSession: "gone-1", title: "Tidy the exports", updatedAt: T - 20 * MIN }),
    ];
    const tracker = {
      isLoaded: () => true,
      known: () => rows,
      row: (id: string) => rows.find((entry) => entry.id === id),
    } as unknown as DelegationTracker;
    const prWatch = {
      id: "w-1",
      ownerSession: "lead-1",
      repo: "acme/app",
      number: 12,
      state: "watching",
      readFailures: 2,
      lastError: "HTTP 403: forbidden",
      lastReadAt: T,
    } as unknown as PrWatch;
    const tried: string[] = [];
    const botRows: string[] = [];
    const told: string[] = [];
    const cleared: string[] = [];
    const care = new HarnessCare({
      now: () => now,
      fix: async (fault) => {
        tried.push(fault.fix!);
        return true;
      },
      fixed: (fault) => {
        botRows.push(SAFE_FIXES[fault.fix!]);
      },
      tell: (fault) => {
        told.push(fault.id);
      },
      clear: (fault) => {
        cleared.push(fault.id);
      },
    });
    const look = (database: { ok: boolean; code?: number; report?: Record<string, unknown> } | null) =>
      careFaults({ now, sessions: [worker, stopped], tracker, database, watches: [prWatch], ship: NO_SHIP, trialSeenAt: null });

    await care.tick(look({ ok: false, code: 1, report: { error: "no such table: sessions" } }));
    expect(told).toEqual(["database"]);
    expect(tried).toEqual([]);

    now = T + MIN;
    await care.tick(look({ ok: false, code: 1, report: { error: "no such table: sessions" } }));
    expect(tried).toEqual(["pause-pr-watch", "continue-chat", "cancel-orphan"]);
    expect(botRows).toEqual([SAFE_FIXES["pause-pr-watch"], SAFE_FIXES["continue-chat"], SAFE_FIXES["cancel-orphan"]]);
    expect(care.state("database")).toMatchObject({ told: true });
    expect(told).toEqual(["database"]); // Told once, though it stands.

    now = T + 2 * MIN;
    await care.tick(look({ ok: true, code: 0 }));
    expect(cleared).toEqual(["database"]);
    log("care: paused the watch, continued c-9, cancelled d-2; Needs you only database");
    expect((await svc.state()).models_called).toBe(0);
  });

  it("retries a chat's own failed turn by itself and then stops, saying so once", () => {
    let now = T;
    const failed = chat("c-2", {
      blocks: [
        block("u-1", "user", "Write the report"),
        block("e-1", "system", "API Error: the connection reset", {
          notice: "error",
          failure: { errorClass: "provider_error", retryable: true, at: T - 2 * MIN },
        }),
      ],
    });
    const fault = faultOf(failed, now)!;
    expect(fault).toBeTruthy();
    const retried: string[] = [];
    const notes: QueuedMessage[] = [];
    const repair = new HarnessRepair({
      now: () => now,
      retry: (id) => {
        retried.push(id);
        return true;
      },
      note: (_id, message) => {
        notes.push(message);
      },
    });
    repair.tick([fault]);
    expect(retried).toEqual(["c-2"]);
    now = T + MIN;
    repair.tick([fault]);
    expect(retried).toEqual(["c-2"]); // Still inside its five minutes.
    now = T + 5 * MIN;
    repair.tick([fault]);
    expect(retried).toEqual(["c-2", "c-2"]);
    now = T + 10 * MIN;
    repair.tick([fault]);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain("2 automatic tries");
    now = T + 30 * MIN;
    repair.tick([fault]);
    expect(notes).toHaveLength(1);
    log("a failed turn: two tries by the app, then one plain line");
  });

  it("called no model and no Grok bot anywhere in the day", async () => {
    const state = await svc.state();
    log("models_called =", state.models_called, "ashos", state.ashos_head);
    expect(state.models_called).toBe(0);
  });
});
