import { expect, it } from "vitest";
import type { NeedsItem } from "../../needs/model/needsYou";
import { needActions } from "./needActions";

it("Yes and Not yet run the needs item's own handlers", () => {
  let picked = "";
  const item: NeedsItem = {
      key: "notes",
      kind: "question",
      who: "Ada",
      at: 1,
      sentence: "Example: Should we ship the notes?",
      actions: [
        { label: "Yes", run: () => { picked = "yes"; } },
        { label: "Not yet", run: () => { picked = "not"; } },
      ],
  };
  const actions = needActions(item);
  expect(actions.map((action) => action.label)).toEqual(["Yes", "Not yet"]);
  actions[0]?.onClick();
  expect(picked).toBe("yes");
  actions[1]?.onClick();
  expect(picked).toBe("not");
});

it("drops a fourth action", () => {
  const item: NeedsItem = {
      key: "many",
      kind: "approval",
      who: "Ada",
      at: 1,
      sentence: "Example: four ways",
      actions: [
        { label: "One", run: () => undefined },
        { label: "Two", run: () => undefined },
        { label: "Three", run: () => undefined },
        { label: "Four", run: () => undefined },
      ],
  };
  expect(needActions(item).map((action) => action.label)).toEqual(["One", "Two", "Three"]);
});
