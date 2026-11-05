import { expect, it } from "vitest";
import { groupTrash, readPayload, withItLabel, type TrashListItem } from "./trash";

function row(kind: string, id: string, withCount = 0): TrashListItem {
  return { kind, id, title: id, deletedAt: 1, version: 1, withCount, payload: "{}" };
}

it("says how many went with an item, and nothing when it is alone", () => {
  expect(withItLabel(0)).toBeNull();
  expect(withItLabel(-1)).toBeNull();
  expect(withItLabel(Number.NaN)).toBeNull();
  expect(withItLabel(1)).toBe("+ 1 with it");
  expect(withItLabel(3)).toBe("+ 3 with it");
});

it("groups items by kind and drops empty groups", () => {
  const groups = groupTrash([row("task", "t"), row("chat", "c"), row("nope", "x")]);
  expect(groups.map((group) => group.kind)).toEqual(["chat", "task", "other"]);
  expect(groups[0].label).toBe("Chats");
});

it("ignores a payload that is not an object", () => {
  expect(readPayload("not json")).toBeNull();
  expect(readPayload("[]")).toBeNull();
  expect(readPayload("null")).toBeNull();
  expect(readPayload("")).toBeNull();
  expect(readPayload('{"mono":{"id":"m1"}}')).toEqual({ mono: { id: "m1" } });
});
