// @vitest-environment happy-dom
// r30h (the blind D5 run on Ash's r49, 22 Oct): (1) a failed app worker sat grey "With Hivra lead" for good while its
// Lead had read the failure and answered Ash as if done: once the failure reached the Lead, nothing retries it, and the
// Lead's turn has ended (its chat isn't busy), it is Ash's: red "Needs you" with the plain reason and "Open <Lead>'s
// chat". While the Lead's turn still runs it stays grey. (2) The worker's card in the Lead's chat showed a green check on
// a failed worker. (3) Being built didn't list a running app worker (its row isn't sent to Ash OS, so no job stands for it).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delegation } from "./delegations";
import * as store from "./delegationStore";
import { stuckOf, stuckOwner } from "./workerStuck";
import * as workerStuck from "./workerStuck";
import { plainStuckLine, stuckWorkerChip } from "./stuckChip";
import * as view from "./delegationView";
import { DelegationBatchRow } from "../ui/DelegationBatchRow";
import type { LaunchedSessionView } from "./monoSpawnedSessions";
import * as stuckJobs from "../../hub/model/stuckJobs";
import type { Worker } from "../../hub/model/types";

const NOW = Date.now();
function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "lead-chat", ownerMono: "hivra-lead", batchId: "turn-1", parentId: null, rootId: id, childSession: `w-${id}`,
    requestId: id, generation: 1, project: "hivra", title: "Example: fix the FAQ", brief: null, goal: null, askIds: [],
    state: "failed", errorClass: null, error: "Stopped with an error.", retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "delivered", deliveryMessage: null, createdAt: NOW - 600_000, updatedAt: NOW - 60_000,
    settledAt: NOW - 60_000, log: [{ at: NOW - 60_000, by: "app", event: "settled", state: "failed" }],
    version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  } as Delegation;
}
const setBusy = (ids: string[]) => (store as unknown as { setBusyChats(ids: string[]): void }).setBusyChats(ids);
const stuck = (r: Delegation) => stuckOf(r, NOW)!;

beforeEach(() => store.resetDelegationStore());

describe("a failed worker whose Lead is done with it", () => {
  // r61 (PM's blind D5 on r60): r30h's red here gave Ash nothing to act on (the Lead had dealt with it), so it stays grey.
  it("stays grey With <Lead>, with the plain reason, once the Lead's turn has ended after reading a plain failure (r61)", () => {
    setBusy([]);
    const failed = row("faq");
    expect(stuckOwner(stuck(failed))).toBe("with-lead");
    expect(stuckWorkerChip(stuck(failed), "Hivra lead")).toEqual({ word: "With Hivra lead", tone: "grey" });
    expect(plainStuckLine(stuck(failed))).toBe("Stopped with an error.");
    // Read through task status, or the Lead's chat went: the same.
    expect(stuckOwner(stuck(row("ack", { delivery: "acknowledged" })))).toBe("with-lead");
    expect(stuckOwner(stuck(row("gone", { delivery: "disposed" })))).toBe("with-lead");
  });

  it("stays grey With <Lead> while the Lead's turn still runs", () => {
    setBusy(["lead-chat"]);
    expect(stuckOwner(stuck(row("faq")))).toBe("with-lead");
    expect(stuckWorkerChip(stuck(row("faq")), "Hivra lead")).toEqual({ word: "With Hivra lead", tone: "grey" });
    // The turn ends: still the Lead's (r61).
    setBusy([]);
    expect(stuckOwner(stuck(row("faq")))).toBe("with-lead");
  });

  it("stays the Lead's until the failure has reached it, and while the Lead retries or splits it", () => {
    setBusy([]);
    expect(stuckOwner(stuck(row("p", { delivery: "pending" })))).toBe("with-lead");
    expect(stuckOwner(stuck(row("q", { delivery: "queued" })))).toBe("with-lead");
    const redo = { at: NOW - 30_000, by: "owner:lead-chat", event: "lead_redo" };
    expect(stuckOwner(stuck(row("r", { log: [...row("r").log, redo] })))).toBe("retrying");
  });

  it("isn't decided when the app hasn't said which chats are busy (a browse-only page)", () => {
    expect(store.chatBusy?.("lead-chat")).toBeUndefined();
    expect(stuckOwner(stuck(row("faq")))).toBe("with-lead");
  });

  it("the app feeds the busy chats from its sessions (Session.busy), with no timer", async () => {
    const { busyChatIds } = await import("../hooks/useBusyChatsFeed");
    expect(busyChatIds([{ id: "lead-chat", busy: true }, { id: "other" }, { id: "w-faq", busy: false }])).toEqual(["lead-chat"]);
  });
});

describe("the worker's card in the Lead's chat", () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows a failed worker as failed, not a green check, though its own chat ended quietly", () => {
    store.setDelegationRows([row("faq", { childSession: "w-faq" })]);
    const views = new Map<string, LaunchedSessionView>([["w-faq", { state: "done", title: "Example: fix the FAQ" }]]);
    act(() =>
      root.render(
        createElement(DelegationBatchRow, {
          launches: [{ sessionId: "w-faq", cwd: "/code/hivra", title: "Example: fix the FAQ", harness: "claude", model: "claude:sonnet-5" }],
          views,
        }),
      ),
    );
    const card = container.querySelector('[data-launched-session="w-faq"]')!;
    expect(card.getAttribute("data-state")).toBe("failed");
    expect(card.getAttribute("aria-label")).toBe("Open session Example: fix the FAQ, failed");
    expect(card.querySelector(".text-emerald-400\\/90")).toBeNull();
  });

  it("lays a row's ending over a quiet chat, but not over one at it again", () => {
    const cardView = (view as Record<string, unknown>).cardView as
      | ((v: LaunchedSessionView | undefined, r: Pick<Delegation, "state">) => LaunchedSessionView | undefined)
      | undefined;
    expect(cardView?.({ state: "done", title: "t" }, { state: "failed" })?.state).toBe("failed");
    expect(cardView?.({ state: "done", title: "t" }, { state: "cancelled" })?.state).toBe("stopped");
    expect(cardView?.({ state: "working", title: "t" }, { state: "failed" })?.state).toBe("working");
    expect(cardView?.({ state: "done", title: "t" }, { state: "completed" })?.state).toBe("done");
  });
});

describe("Being built", () => {
  const where = {
    project: (r: Delegation) => r.project ?? undefined,
    lead: () => ({ id: "hivra-lead", name: "Hivra lead" }),
  };
  type AppWorkers = (projectId: string, jobs: readonly Worker[], rows: readonly Delegation[], now: number, w: typeof where) => Worker[];
  const appWorkers = (stuckJobs as Record<string, unknown>).appWorkers as AppWorkers | undefined;

  it("lists a running app worker no Ash OS job stands for, under its Mono", () => {
    const running = row("run", { state: "running", error: null, delivery: "pending", settledAt: null, log: [] });
    const listed = appWorkers?.("hivra", [], [running], NOW, where) ?? [];
    expect(listed.map((w) => [w.who, w.doing, w.sourceRef])).toEqual([["Hivra lead", "Example: fix the FAQ", "delegation:run"]]);
    expect(listed[0]?.minutes).toBe(10);
    // Another project's worker isn't listed here.
    expect(appWorkers?.("exo", [], [running], NOW, where)).toEqual([]);
  });

  it("leaves a row a job already covers to that job, and folds a worker's own workers under it", () => {
    const running = row("run", { state: "running", error: null, delivery: "pending", settledAt: null, log: [] });
    const child = row("kid", { state: "running", parentId: "run", rootId: "run", error: null, delivery: "pending", settledAt: null, log: [] });
    const job = { id: "j1", sourceRef: "delegation:run" } as Worker;
    expect(appWorkers?.("hivra", [job], [running, child], NOW, where)).toEqual([]);
    expect(appWorkers?.("hivra", [], [running, child], NOW, where)?.map((w) => w.id)).toEqual(["app:run"]);
  });

  it("keeps a failed one listed while it is stuck, and drops a finished one", () => {
    setBusy([]);
    const failed = appWorkers?.("hivra", [], [row("faq")], NOW, where) ?? [];
    expect(failed.map((w) => w.id)).toEqual(["app:faq"]);
    const laid = stuckJobs.withStuckWorkers(failed, [row("faq")], NOW);
    expect(laid[0]?.stuckWorker && stuckWorkerChip(laid[0].stuckWorker, "Hivra lead")).toEqual({ word: "With Hivra lead", tone: "grey" });
    expect(appWorkers?.("hivra", [], [row("done", { state: "completed", error: null })], NOW, where)).toEqual([]);
  });

  it("the list still folds a worker under its job", () => {
    // WP-06: Being built is gone. The rail's list (needsYouRows) still folds app workers the same way.
    expect(workerStuck.rowsUnderJob("delegation:run", [row("run")]).map((r) => r.id)).toEqual(["run"]);
  });
});

// r51, PM's gap: a Lead chat this window doesn't hold (another window, or not loaded) was taken as not busy, so its failed
// worker could go red while its turn still ran. Now its run state is unknown here and the worker stays its Lead's.
describe("r51: a Lead chat this window doesn't hold", () => {
  it("is not known, never 'not busy': its failed worker stays grey With <Lead>", () => {
    store.setBusyChats([], ["some-other-chat"]);
    expect(store.chatBusy("lead-chat")).toBeUndefined();
    expect(stuckOwner(stuck(row("faq")))).toBe("with-lead");
  });

  // r61: a plain failure no longer goes red; a worker's own "I can't go on" still does once its Lead's turn is over.
  it("once this window holds it and it isn't running, a worker that said it can't go on goes red", () => {
    const blocked = row("faq", { state: "running", stallKind: "blocked", error: null, delivery: "pending", settledAt: null, stalledAt: NOW - 60_000,
      log: [{ at: NOW - 60_000, by: "child:w-faq", event: "stalled" }] } as Partial<Delegation>);
    store.setBusyChats([], ["lead-chat"]);
    expect(store.chatBusy("lead-chat")).toBe(false);
    expect(stuckOwner(stuck(blocked))).toBe("needs-you");
    store.setBusyChats(["lead-chat"], ["lead-chat"]);
    expect(stuckOwner(stuck(blocked))).toBe("with-lead");
  });
});
