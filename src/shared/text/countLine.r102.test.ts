import { describe, expect, it } from "vitest";
import { withCountLineChecked } from "./countLine";

const list = (n: number, w: string) => Array.from({ length: n }, (_, i) => `- ${w} ${i + 1}`).join("\n");

describe("r102 (3, 9): the count line matches the groups it sums up and opens the reply", () => {
  it("05bc: 11 done / 1 already there / 27 parked over 10 done, 1 blocked and 28 parked items is corrected", () => {
    const text = `Of 40: 11 done, 1 already there, 1 blocked by your answer, 27 parked.\n\nDone.\n\n${list(10, "fix")}\n\nBlocked by your answer:\n- the shortcut\n\nParked:\n${list(28, "idea")}`;
    const out = withCountLineChecked(text);
    expect(out.split("\n")[0]).toBe("Of 39: 10 done, 1 blocked by your answer, 28 parked.");
  });
  it("already there folds into done when there is no list to recount from", () => {
    expect(withCountLineChecked("Of 40: 11 done, 1 already there, 28 parked.\n\nThe hub fixes are in.").split("\n")[0]).toBe("Of 40: 12 done (1 already there), 28 parked.");
  });
  it("the count line moves to the top", () => {
    const out = withCountLineChecked("Here is where things stand.\n\nOf 5: 2 done, 3 parked.");
    expect(out.startsWith("Of 5: 2 done, 3 parked.\n\nHere is where things stand.")).toBe(true);
  });
  it("a reply without a count line is unchanged", () => {
    expect(withCountLineChecked("Done. Nothing new for you.")).toBe("Done. Nothing new for you.");
  });
});

it("r102 (d71c): each status line is its own paragraph, list items stay together", () => {
  const out = withCountLineChecked("Of 3: 2 done, 1 parked.\nNothing is in your Inbox.\nDone:\n- a\n- b\nParked: c");
  expect(out).toBe("Of 3: 2 done, 1 parked.\n\nNothing is in your Inbox.\n\nDone:\n- a\n- b\n\nParked: c");
});
