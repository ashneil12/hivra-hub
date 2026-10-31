// r100 (e): an option never repeats the question's opening words (B5 936c: "Today at the top. Add a section").
import { expect, it } from "vitest";
import { orOptions } from "./chatQuestions";
import { withoutAskMarkers } from "../../../shared/text/askMarkers";

it("takes the choices from the question's last sentence", () => {
  expect(orOptions("Today at the top. Add a section, or move an existing one?")).toEqual(["Add a section", "Move an existing one"]);
  expect(orOptions("Keep that all-time order, or sort by this week?")).toEqual(["Keep that all-time order", "Sort by this week"]);
});

it("a 'My pick:' in the middle of a line reads to Ash too (B5 fc68)", () => {
  const shown = withoutAskMarkers("- Undo after archive: a short toast, or a longer window? My pick: a toast, a few seconds.");
  expect(shown).not.toMatch(/my pick/i);
  expect(shown).toContain("? I'd go with a toast, a few seconds.");
});

it("drops a subject before the last comma: no option repeats the question's opening words (B5 842b)", () => {
  const options = orOptions("Share link on Nibbii, view-only or editable?");
  expect(options.map((o) => o.toLowerCase())).toEqual(["view-only", "editable"]);
});
