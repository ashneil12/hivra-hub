import { describe, expect, it } from "vitest";
import { engineCrewChat, type EngineCrewStart } from "./engineCrew";

const owner = {
  cwd: "/example/project",
  harness: "claude" as const,
  model: "claude:opus-5-5",
  modelSettings: { effort: "high" },
  runtimeMode: "supervised" as const,
};
const start: EngineCrewStart = {
  type: "crew.started",
  callId: "item-1",
  sessionId: "crew-chat-1",
  title: "Example: count the lines",
  brief: "Example: count the lines of README.md\nand say how you counted.",
};

describe("a chat for a crew member the engine started", () => {
  it("opens quietly on its first mate's folder, model and permission mode, with the brief as its first message", () => {
    const chat = engineCrewChat(owner, start, [{ id: "mate-1" }], [[{ id: "turn-1" }], [{ id: "turn-2" }, { id: "reply-2" }]]);
    expect(chat).toEqual({
      launch: {
        prompt: "Example: count the lines of README.md\nand say how you counted.",
        title: "Example: count the lines",
        cwd: "/example/project",
        harness: "claude",
        model: "claude:opus-5-5",
        modelSettings: { effort: "high" },
        runtimeMode: "supervised",
        reveal: false,
      },
      card: { sessionId: "crew-chat-1", cwd: "/example/project", title: "Example: count the lines", harness: "claude", model: "claude:opus-5-5" },
      turnId: "turn-2",
    });
  });

  it("is made once, and still has something to show when the engine gave no brief or title", () => {
    expect(engineCrewChat(owner, start, [{ id: "crew-chat-1" }], [])).toBeNull();
    const bare = engineCrewChat(owner, { ...start, title: " ", brief: "" }, [], []);
    expect(bare?.launch.prompt).toBe("Crew member");
    expect(bare?.card.title).toBe("Crew member");
    expect(bare?.turnId).toBeUndefined();
  });
});
