import { describe, expect, it } from "vitest";
import type { FirstMateItem } from "../../crew/model/inbox";
import { foldFirstMate } from "./inboxFold";
import type { NeedsItem } from "./needsYou";

const PROJECT = "/work/proj";
const projectOf = (path: string) => (path === PROJECT ? "proj" : path === "/work/other" ? "other" : undefined);

function need(key: string, patch: Partial<NeedsItem> = {}): NeedsItem {
  return { key, kind: "question", projectId: "proj", who: "Coding team", at: 1, sentence: key, actions: [], ...patch };
}

function decision(key: string, project = PROJECT): FirstMateItem {
  return {
    id: `decision:${project}:${key}`,
    kind: "decision",
    title: key,
    body: "",
    statusWord: "needs you",
    chatId: null,
    workerIds: [],
    options: ["Yes", "No"],
    recommended: null,
    project,
    key,
    version: 1,
    since: 1,
    updatedAt: 1,
  };
}

describe("foldFirstMate", () => {
  it("puts a decision on the Needs you row that names it, once", () => {
    const rows = foldFirstMate(
      [need("stopped:w1", { kind: "stopped" }), need(`question:${PROJECT}:ship`, { decisionKey: "ship" })],
      [decision("ship")],
      projectOf,
    );
    expect(rows.map((row) => [row.key, row.decision?.key ?? null])).toEqual([
      ["stopped:w1", null],
      [`question:${PROJECT}:ship`, "ship"],
    ]);
  });

  it("matches a parked decision by its gate key in any spelling", () => {
    const rows = foldFirstMate([need("check:Gate/Ship", { kind: "check", gateKey: "Gate/Ship" })], [decision("gate/ship")], projectOf);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision?.key).toBe("gate/ship");
  });

  it("does not fold a decision of another project into a row with the same key", () => {
    const rows = foldFirstMate([need("question:other:ship", { decisionKey: "ship", projectId: "other" })], [decision("ship")], projectOf);
    expect(rows.map((row) => [row.need?.key ?? null, row.decision?.key ?? null])).toEqual([
      ["question:other:ship", null],
      [null, "ship"],
    ]);
  });

  it("keeps a decision no row names yet at the end, so it never drops out of the Inbox", () => {
    const rows = foldFirstMate([need("stopped:w1", { kind: "stopped" })], [decision("late")], projectOf);
    expect(rows.map((row) => row.key)).toEqual(["stopped:w1", `decision:${PROJECT}:late`]);
    expect(rows[1]?.need).toBeNull();
  });

  it("leaves the list as it is without the panel's decisions", () => {
    const needs = [need(`question:${PROJECT}:ship`, { decisionKey: "ship" })];
    expect(foldFirstMate(needs, [], projectOf)).toEqual([{ key: needs[0]!.key, need: needs[0], decision: null }]);
  });
});
