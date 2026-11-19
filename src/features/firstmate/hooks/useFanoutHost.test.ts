// @vitest-environment happy-dom
// WP-171: the fan-out host the app lends the worker queue: a provider's row read back from the store, and a provider
// held for its fresh-eyes review read as not started yet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { answering, FINDING, fakeInbox, windowOn } from "../../fresh-eyes/testing/world";
import { reviewBeforeCrew } from "../../fresh-eyes/model/gate";
import { setFreshEyesStorage, writeSetting } from "../../fresh-eyes/model/store";
import type { Delegation } from "../../monos/model/delegations";
import { resetWorkerPool } from "../../monos/model/workerPool";
import { forgetVerifications } from "../model/fanoutChecks";
import { parseFanout } from "../model/fanoutContract";
import { planFanout } from "../model/fanoutWaves";
import { appFanoutHost } from "./useFanoutHost";

vi.mock("../../../platform/tauri/fs", () => ({ statFiles: vi.fn(async () => []), readTextFile: vi.fn(async () => "") }));

const PROJECT = "/work/tally";
const [, board] = planFanout(
  parseFanout({
    intent: "Ash: a score board.",
    tasks: [
      { name: "api", brief: "Add the route in src/api/score.ts", goal: "it answers", owns: ["src/api/score.ts"], provides: [{ kind: "endpoint", name: "/api/score" }] },
      { name: "board", brief: "Show it in src/ui/Board.tsx", goal: "it shows", requires: ["/api/score"] },
    ],
  }),
  "lead",
  "r1",
  0,
).links;
const job = { id: board.tasks.board.session, fanout: board };
const queued = {
  id: job.id,
  ownerSession: "lead",
  requestId: "r1-board",
  project: "tally",
  projectName: "Tally",
  title: "board",
  heavy: false,
  harness: "claude",
  queuedAt: 0,
  input: { brief: "x", fanout: board },
};

afterEach(() => {
  setFreshEyesStorage(undefined);
  resetWorkerPool();
  forgetVerifications();
});

describe("the app's fan-out host (WP-171)", () => {
  it("reads a provider's row from the store when this window has none", async () => {
    const stored = { id: "t-1", childSession: board.tasks.api.session, state: "running", version: 1, updatedAt: 1 } as Delegation;
    const owned = vi.fn(async () => [stored]);
    const built = appFanoutHost({ rows: () => [], folder: () => PROJECT }, { owned } as never);
    await built.settle([queued]);
    expect(owned).toHaveBeenCalledWith({ ownerSession: "lead", requestIds: [board.tasks.api.session] });
    expect(built.dependency(job)?.line).toMatch(/api is still working/);
  });

  it("waits for a provider held for its fresh-eyes review instead of holding what needs it", async () => {
    const storage = windowOn(memoryDisk(), "a");
    setFreshEyesStorage(storage);
    const owned = vi.fn(async () => []);
    const built = appFanoutHost({ rows: () => [], folder: () => PROJECT }, { owned } as never);
    await built.settle([queued]);
    expect(built.dependency(job)?.reason).toBe("held");
    await writeSetting(PROJECT, { enabled: true }, storage);
    const answer = await reviewBeforeCrew(
      { project: PROJECT, requestId: "f2_r1-api", plan: "Add the route.", ownerSession: "lead", held: { brief: "Add the route." } },
      { storage, port: answering(FINDING), backend: fakeInbox() },
    );
    await answer.settled;
    expect(answer.hold).toBe(true);
    expect(built.dependency(job)).toMatchObject({ reason: "requires", line: expect.stringContaining("api has not started yet") });
  });

});
