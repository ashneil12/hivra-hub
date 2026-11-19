import { expect, it } from "vitest";
import { monoState } from "./mono";
import type { Delegation } from "./delegations";
const row: Delegation = {
  id: "example-task",
  ownerSession: "example-lead",
  ownerMono: null,
  childSession: "example-worker",
  batchId: null,
  parentId: null,
  rootId: "example-task",
  requestId: "example-request",
  generation: 1,
  project: null,
  title: "Example: export invoices",
  brief: null,
  goal: null,
  askIds: [],
  state: "running",
  errorClass: null,
  error: null,
  retryable: null,
  resetsAt: null,
  result: null,
  pendingQuestion: null,
  delivery: "pending",
  deliveryMessage: null,
  createdAt: 1,
  updatedAt: 1,
  settledAt: null,
  log: [],
  version: 1,
  mirroredVersion: 0,
  mirrorError: null,
};
it("an idle lead with active crew reads working, without double counting mirrored rows", () => {
  const session = { id: "example-lead", blocks: [], busy: false };
  expect(monoState(session, [row, row])).toMatchObject({
    status: "working",
    activity: "1 job with its crew",
  });
  expect(
    monoState(session, [{ ...row, state: "done", version: 2 }, row]),
  ).toMatchObject({ status: "idle" });
  expect(monoState({ ...session, id: "other" }, [row])).toMatchObject({
    status: "idle",
  });
});

it("shows queued-only work as paused, not idle, until it starts or is cancelled", () => {
  const session = { id: "example-lead", blocks: [], busy: false };
  expect(
    monoState(session, [], [{ ownerSession: "example-lead" }]),
  ).toMatchObject({ status: "paused", activity: "1 job waiting to start" });
  expect(monoState(session, [], [])).toMatchObject({ status: "idle" });
});
