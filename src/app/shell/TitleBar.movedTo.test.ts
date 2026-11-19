import { describe, expect, it } from "vitest";
import { tabCopy } from "./TitleBar";

describe("WP-177: the header says where a moved chat went", () => {
  it("shows Moved to <host> in the meta line of the focused chat's tab", () => {
    const copy = tabCopy({
      id: "t1", project: "app", title: "Chat", more: [], sessionCount: 1, harnesses: ["claude"], busyHarnesses: [],
      doneHarnesses: [], files: [], multiPane: false, fileFocused: false, blank: false, movedTo: "Studio box",
    } as never);
    expect(copy.meta).toContain("Moved to Studio box");
  });

  it("shows no moved text for a chat that did not move", () => {
    const copy = tabCopy({
      id: "t1", project: "app", title: "Chat", more: [], sessionCount: 1, harnesses: ["claude"], busyHarnesses: [],
      doneHarnesses: [], files: [], multiPane: false, fileFocused: false, blank: false,
    } as never);
    expect(copy.meta).not.toContain("Moved");
  });
});
