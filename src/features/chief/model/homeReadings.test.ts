import { describe, expect, it } from "vitest";
import { readingsOf } from "./homeReadings";

describe("readingsOf", () => {
  it("keeps both projects and marks a stuck task, and drops a trashed row", () => {
    const projects = [
      { id: "crew", name: "Crew", folder: "C:\\work\\crew" },
      { id: "site", name: "Site", folder: "/work/site" },
    ];
    const readings = readingsOf({
      projects,
      tasks: [
        { id: "write", projectId: "C:\\work\\crew", title: "Write the notes", status: "In progress", source: "", assignee: null, needsYou: false, trashedAt: null, createdAt: 1 },
        { id: "paint", projectId: "site", title: "Paint the door", status: "Blocked", source: "", assignee: null, needsYou: false, trashedAt: null, createdAt: 2 },
        { id: "gone", projectId: "site", title: "Gone", status: "Stuck", source: "", assignee: null, needsYou: false, trashedAt: 3, createdAt: 3 },
      ],
      docs: [
        { id: "plan", title: "Crew plan", lastOpenedAt: 1, trashedAt: null },
        { id: "spec", title: "Site spec", lastOpenedAt: 2, trashedAt: 4 },
      ],
      decisions: [{ project: "crew", decisionKey: "ship", question: "Should we ship?", state: "open", createdAt: 1 }],
      chats: [{ id: "c1", title: "Lead chat", projectId: "crew", openedAt: 1 }],
    });
    expect(readings.map((reading) => [reading.kind, reading.id, reading.projectId, reading.stuck])).toEqual([
      ["task", "write", "crew", false],
      ["task", "paint", "site", true],
      ["doc", "plan", "", false],
      ["decision", "ship", "crew", false],
      ["chat", "c1", "crew", false],
    ]);
  });
});
