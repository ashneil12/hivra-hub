import { afterEach, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import { setDelegationRows } from "../../monos/model/delegationStore";
import { needsCount, needsYou, setNeedsYouItems, workingCount } from "./needsYou";

afterEach(() => {
  setNeedsYouItems([]);
  setDelegationRows([]);
});

function row(over: Partial<Delegation>): Delegation {
  return {
    id: "d1",
    ownerSession: "owner",
    ownerMono: null,
    batchId: null,
    parentId: null,
    rootId: "d1",
    childSession: "child",
    requestId: "r",
    generation: 1,
    project: "crew",
    title: "Notes",
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
    ...over,
  };
}

it("drops a bad needs row and keeps three actions at most", () => {
  let picked = "";
  const items = needsYou({
    items: [
      { key: "question:1", kind: "question", who: "Ada", at: 2, sentence: "Which font?", actions: [], open: { kind: "inbox" } },
      { key: "", kind: "question", at: 1, sentence: "no key", open: { kind: "inbox" } },
      { key: "stopped:1", kind: "nope", at: 1, sentence: "bad", open: { kind: "inbox" } },
      {
        key: "stopped:2",
        kind: "stopped",
        at: 1,
        sentence: "It stopped.",
        actions: [
          { label: "One", run: () => undefined },
          { label: "Two", run: () => undefined },
          { label: "Three", run: () => undefined },
          { label: "Four", run: () => undefined },
        ],
        open: { kind: "chat", id: "c1" },
      },
      {
        key: "question:notes",
        kind: "question",
        at: 3,
        sentence: "Example: Should we ship the notes?",
        actions: [
          { label: "Yes", run: () => { picked = "yes"; } },
          { label: "Not yet", run: () => { picked = "not"; } },
        ],
        open: { kind: "inbox" },
      },
    ],
  }, Date.now());
  expect(items.map((item) => item.key)).toEqual(["stopped:2", "question:1", "question:notes"]);
  expect(items[0].actions.map((action) => action.label)).toEqual(["One", "Two", "Three"]);
  const notes = items.find((item) => item.key === "question:notes");
  notes?.actions[0]?.run();
  expect(picked).toBe("yes");
  notes?.actions[1]?.run();
  expect(picked).toBe("not");
});

it("counts running workers the same way a project filter does", () => {
  setDelegationRows([
    row({ id: "a", project: "crew" }),
    row({ id: "b", project: "crew" }),
    row({ id: "c", project: "notes" }),
    row({ id: "d", state: "question" }),
    row({ id: "e", state: "failed" }),
    row({ id: "" }),
  ]);
  expect(workingCount()).toBe(3);
  expect(workingCount("crew")).toBe(2);
  expect(workingCount("notes")).toBe(1);
  expect(needsCount()).toBe(0);
});
