/**
 * WP-91: an irreversible step is the person's to answer, so the decision it raises has to reach a screen. The Inbox
 * shows a project's open decisions only under that project, and Home names a decision's project from its id; a
 * decision raised with no project reached neither. These read the ask exactly as the app sends it, stored the way
 * src-tauri/src/decisions.rs keeps it, and put it in front of both screens.
 */
import { describe, expect, it } from "vitest";
import { decisionAskInput, irreversibleDecisionKey } from "./orchestration";
import { inboxItems } from "../../crew/model/inbox";
import { needsYouLines } from "../../home/model/lines";

const stored = (ask: ReturnType<typeof decisionAskInput>) => ({
  project: ask.project ?? "",
  decisionKey: ask.key,
  question: ask.question,
  options: ask.options,
  recommended: ask.recommended,
  askedBy: ask.askedBy,
  waiting: [],
  state: "open",
  createdAt: 1,
  updatedAt: 1,
});

const ask = (project?: string) =>
  decisionAskInput({
    leadId: "lead-1",
    taskId: "task-1",
    title: "Migrate the shared database",
    reason: "it changes the table every project reads.",
    project,
  });

describe("an irreversible step's decision on the person's screens", () => {
  it("is in the project's Inbox with its two answers, when the project is a folder", () => {
    const items = inboxItems({
      project: "/Users/ash/Projects/app",
      decisions: [stored(ask("/Users/ash/Projects/app"))],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "decision",
      key: irreversibleDecisionKey("lead-1", "task-1"),
      options: ["Approve", "Send back"],
      recommended: "Send back",
    });
    expect(items[0].title).toContain("Migrate the shared database cannot be undone");
  });

  it("is on Home under the hub project's name, when the folder is a hub project", () => {
    const lines = needsYouLines(
      [stored(ask("hivra"))],
      [],
      (id) => (id === "hivra" ? "Hivra" : ""),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].projectId).toBe("hivra");
    expect(lines[0].text.startsWith("Hivra · Migrate the shared database")).toBe(true);
  });

  it("had no project before, and the Inbox left it out", () => {
    // The control: an ask with no project (what the app sent until now) is under "", which no Inbox shows.
    expect(
      inboxItems({
        project: "/Users/ash/Projects/app",
        decisions: [stored(ask(undefined))],
      }),
    ).toEqual([]);
  });
});
