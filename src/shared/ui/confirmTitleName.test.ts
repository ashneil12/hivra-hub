import { describe, expect, it } from "vitest";
import { confirmTitleName } from "./ConfirmDelete";

describe("confirm title name (r30i)", () => {
  it("drops markdown and the trailing dots before the question mark", () => {
    expect(confirmTitleName("The current branch is **pm/pages-live**")).toBe("The current branch is pm/pages-live");
  });
  it("keeps the cut mark on a title that arrives already cut", () => {
    expect(confirmTitleName("I'll read the current branch from the MonoCode\u2026")).toBe("I'll read the current branch from the MonoCode\u2026");
    expect(confirmTitleName("The current branch is **pm/pages-live**...")).toBe("The current branch is pm/pages-live\u2026");
  });
  it("does not double punctuation", () => {
    expect(`Delete ${confirmTitleName("Nothing has changed.")}?`).toBe("Delete Nothing has changed?");
  });
  it("drops a question's own marks", () => {
    expect(confirmTitleName("Is it done?!")).toBe("Is it done");
  });
  it("keeps one line and cuts long titles at a word", () => {
    const t = confirmTitleName("Make a marketing chat\nwith CoS and PM about the launch plan for next week please and more words");
    expect(t).not.toContain("\n");
    expect(t.endsWith("\u2026")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(61);
  });
  it("keeps links' text, code and plain names", () => {
    expect(confirmTitleName("See [the doc](https://x.y) and `npm test`")).toBe("See the doc and npm test");
    expect(confirmTitleName("Example: tidy the README")).toBe("Example: tidy the README");
    expect(confirmTitleName("Marketing")).toBe("Marketing");
    expect(confirmTitleName("**")).toBe("this");
  });
});
