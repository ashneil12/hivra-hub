// @vitest-environment happy-dom
// r52 (PM's r51 run, 22 Oct): the same red row read "2h" on Today and "for 6 min" on Being built: Today counted from
// when its worker failed, Being built from when its job started. One clock now: how long it has been stuck this way.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import { stuckMinutes, type StuckWorker } from "../../monos/model/workerStuck";
import { StuckList } from "../../monos/ui/StuckWorkerCard";
import type { Worker } from "../model/types";
import { jobTimeLabel } from "./BeingBuiltView";

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

const now = Date.parse("2026-10-22T17:06:00Z");
const failedAt = now - 2 * 60 * 60_000; // it failed two hours ago
const row = {
  id: "d1", ownerSession: "hivra-chat", ownerMono: "hivra-lead", rootId: "d1", childSession: "c-d1", state: "failed",
  title: "Tidy Hivra README setup steps", errorClass: "billing", error: "Stopped with an error.", retryable: null,
  delivery: "pending", createdAt: failedAt - 60_000, updatedAt: failedAt, settledAt: failedAt, log: [],
} as unknown as Delegation;
const stuck: StuckWorker = { row, kind: "failed", line: "Stopped with an error.", since: failedAt, escalated: true, key: "k1" };
// Its job started six minutes ago (Ash OS's minutes): not how long it has needed Ash.
const job = { id: "j1", projectId: "hivra", who: "Hivra lead", kind: "job", doing: "Tidy Hivra README setup steps", minutes: 6,
  steps: [], lead: "hivra-lead", stuck: "stuck", stuckWorker: stuck } as unknown as Worker;

describe("a red row's time (r52)", () => {
  it("is how long its worker has been stuck, on Being built and on Today alike", () => {
    expect(stuckMinutes(stuck, now)).toBe(120);
    expect(jobTimeLabel(job, now)).toBe("for 2 h");
    act(() => root.render(createElement(StuckList, { stuck: [stuck], now, variant: "row", where: () => "Hivra lead" })));
    expect(container.querySelector("[data-stuck-ago]")?.textContent).toBe("2h");
  });
  it("a job nothing of the app's holds up still reads how long it has run", () => {
    const plain = { ...job, stuck: undefined, stuckWorker: undefined } as unknown as Worker;
    expect(jobTimeLabel(plain, now)).toBe("for 6 min");
    expect(jobTimeLabel({ ...job, stuckWorker: { ...stuck, since: now - 20_000 } } as Worker, now)).toBe("just now");
  });
});
