// r52 (PM's r51 run, 22 Oct): a coding team's sub-chats listed as "claude · I'll run that comma…" and
// "claude · [MonoCode brief fr…", and the Hub lead's chat could not be renamed. A list title has no harness label and
// no leading [MonoCode …] tag, and a Lead's chat renames under its own title.
import { describe, expect, it } from "vitest";
import { leadRenameRow, subChatsByParent } from "../../features/hub/model/codingTeamList";
import { sessionDisplayTitle, titleFromPrompt } from "../../features/sessions/model/session";
import { listTitle } from "./plainTitle";

describe("list titles (r52)", () => {
  it("drop the harness label and a leading [MonoCode …] tag, closed or cut", () => {
    expect(listTitle("claude · I'll run that command")).toBe("I'll run that command");
    expect(listTitle("claude · [MonoCode brief from MonoCode Hub lead] Fix the **FAQ**")).toBe("Fix the FAQ");
    expect(listTitle("[MonoCode report] done: tidy README")).toBe("done: tidy README");
    expect(listTitle("claude · [MonoCode brief fr…")).toBe("");
    expect(listTitle("Codex · plan")).toBe("plan");
    // Words that only look like it stay.
    expect(listTitle("Claude Code review")).toBe("Claude Code review");
    expect(listTitle("[MonoCodeX] keep")).toBe("[MonoCodeX] keep");
    expect(listTitle("Fix [MonoCode brief] later")).toBe("Fix [MonoCode brief] later");
  });
  it("a chat's display title and a title made from a Hub turn use it", () => {
    expect(sessionDisplayTitle("claude · [MonoCode brief from MonoCode Hub lead] Fix docs", "claude")).toBe("Fix docs");
    expect(sessionDisplayTitle("claude · [MonoCode brief fr…", "claude")).toBe("New session");
    expect(titleFromPrompt("[MonoCode brief from MonoCode Hub lead]\nTidy the Hivra README", "claude")).toBe(
      "claude · Tidy the Hivra README",
    );
  });
  it("a coding team's sub-chats list without the label or tag", () => {
    const { byParent } = subChatsByParent(
      ["lead-1"],
      [
        { id: "app-lead-1-a", title: "claude · I'll run that command", createdAt: 2 },
        { id: "app-lead-1-b", title: "claude · [MonoCode brief fr…", createdAt: 1 },
      ],
      [],
      new Set(),
    );
    expect(byParent.get("lead-1")?.map((chat) => chat.title)).toEqual(["I'll run that command", "Started chat"]);
  });
  it("a Lead's chat renames under its own title, once it exists", () => {
    const session = { id: "s-1", cwd: "/p", harness: "claude", title: "MonoCode Hub lead" } as never;
    expect(leadRenameRow({ session, chatTitle: "claude · QA test from the test run (D5, stuck worker)" })?.title).toBe(
      "claude · QA test from the test run (D5, stuck worker)",
    );
    expect(leadRenameRow({ session })).toBeUndefined();
    expect(leadRenameRow({ session: { ...(session as object), id: "lead:hub-lead" } as never, chatTitle: "x" })).toBeUndefined();
  });
});
