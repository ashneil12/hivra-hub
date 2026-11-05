import { describe, expect, it } from "vitest";
import { mentionCatalog } from "./mentionCatalog";

describe("mentionCatalog", () => {
  it("names pages, tasks, chats and Monos, and drops duplicates and blank ids", () => {
    const targets = mentionCatalog({
      pages: [
        { id: "page-1", title: "Plan" },
        { id: "  ", title: "Nope" },
      ],
      tasks: [{ id: "task-1", title: "Write the spec" }],
      chats: [{ id: "chat-1", title: "Standup", cwd: "/tmp/project" }],
      monos: [{ id: "mono-1", name: "Ada", projects: ["/tmp/project"] }],
      extra: [{ kind: "page", id: "page-1", name: "Plan again" }],
    });
    expect(targets).toEqual([
      { kind: "page", id: "page-1", name: "Plan" },
      { kind: "task", id: "task-1", name: "Write the spec" },
      { kind: "chat", id: "chat-1", name: "Standup" },
      { kind: "mono", id: "mono-1", name: "Ada" },
    ]);
  });

  it("keeps this project's chats and leaves out asks, workers and other projects", () => {
    const targets = mentionCatalog({
      scope: "/tmp/project",
      chats: [
        { id: "here", title: "Here", cwd: "/tmp/project" },
        { id: "loose", title: "Loose", cwd: "" },
        { id: "away", title: "Away", cwd: "/other/project" },
        { id: "ask", title: "Ask", cwd: "/tmp/project", inboxAsk: { id: "a" } },
        { id: "temp", title: "Temp", cwd: "/tmp/project", ephemeral: true },
        { id: "worker", title: "Worker", cwd: "/tmp/project", orchestrationLeadId: "lead" },
      ],
      monos: [
        { id: "mine", name: "", projects: ["/tmp/project"] },
        { id: "free", name: "Free", projects: [] },
        { id: "theirs", name: "Theirs", projects: ["/other/project"] },
      ],
    });
    expect(targets.map((target) => target.id)).toEqual(["here", "loose", "mine", "free"]);
    expect(targets.find((target) => target.id === "mine")?.name).toBe("Untitled");
  });
});
