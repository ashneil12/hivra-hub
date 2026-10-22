import { expect, it } from "vitest";
import { plainForAsh } from "./plainForAsh";

it("drops raw task ids and turns absolute paths into their last part", () => {
  expect(plainForAsh("C7 is running (t-9bd8c17f). One worker is on it.")).toBe("C7 is running. One worker is on it.");
  expect(plainForAsh("Done in task t-618b405a-7efd-49d1-81ef-428ff608c405, tests pass.")).toBe("Done, tests pass.");
  expect(plainForAsh("The preview is at /Users/ash/Worktrees/hub-c7/dist/index.html.")).toBe("The preview is at index.html.");
  expect(plainForAsh("Changed ~/Projects/monocode-hub/src/Today.tsx and checked it.")).toBe("Changed Today.tsx and checked it.");
});

it("leaves ordinary words, short codes and relative names alone", () => {
  for (const text of ["Fixed the save bug.\nTests pass.", "Commit 3a447aa is on the branch.", "See src/Today.tsx for the card.", "t-shirt sizes"])
    expect(plainForAsh(text)).toBe(text);
});
