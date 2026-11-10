import { describe, expect, it, vi } from "vitest";
import { newSession } from "../../sessions/model/session";
import { mobileQuestionReply } from "./mobileWorkspace";

const prompt = {
  requestId: 1,
  questions: [
    {
      id: "colour",
      prompt: "Which colour?",
      multiSelect: false,
      allowCustom: true,
      options: [
        { id: "red", label: "Red" },
        { id: "blue", label: "Blue" },
      ],
    },
    {
      id: "size",
      prompt: "Which sizes?",
      multiSelect: true,
      allowCustom: false,
      options: [
        { id: "s", label: "Small" },
        { id: "l", label: "Large" },
      ],
    },
  ],
};

describe("mobile question replies", () => {
  it("keeps the questions and options asked, and a deliberate partial answer", () => {
    expect(
      mobileQuestionReply(
        { kind: "answered", answers: { colour: ["red"], size: ["s", "xl"], other: ["x"] } },
        prompt,
      ),
    ).toEqual({ kind: "answered", answers: { colour: ["red"], size: ["s"] } });
    expect(
      mobileQuestionReply(
        { kind: "answered", answers: { colour: ["__custom__"] }, custom: { colour: " Teal " } },
        prompt,
      ),
    ).toEqual({ kind: "answered", answers: { colour: ["__custom__"] }, custom: { colour: "Teal" } });
  });

  it("skips only when asked to, rejecting answers that leave nothing answered", () => {
    expect(mobileQuestionReply({ kind: "skipped" }, prompt)).toEqual({ kind: "skipped" });
    expect(mobileQuestionReply({ kind: "answered", answers: { colour: ["green"] } }, prompt)).toBeUndefined();
    expect(
      mobileQuestionReply(
        { kind: "answered", answers: { colour: ["__custom__"] }, custom: { colour: "x".repeat(10_001) } },
        prompt,
      ),
    ).toBeUndefined();
    expect(mobileQuestionReply({ kind: "maybe" }, prompt)).toBeUndefined();
    expect(mobileQuestionReply(null, prompt)).toBeUndefined();
  });
});

describe("mobile catalog private chats", () => {
  it("keeps a private chat off the phone's session list, live or saved", async () => {
    // L2: a private chat's title and state must not reach the phone through the workspace poll.
    vi.resetModules();
    vi.doMock("../../sessions/data/sessionStore", () => ({
      getSession: async () => undefined,
      listSessionsByProject: async () => [
        { id: "saved-private", cwd: "/work/p", title: "Secret", harness: "claude", model: "opus", updatedAt: 1, private: true },
        { id: "saved-open", cwd: "/work/p", title: "Open", harness: "claude", model: "opus", updatedAt: 2 },
      ],
    }));
    vi.doMock("../../monos/model/mono", () => ({
      listMonos: () => [],
      monoLook: () => ({ name: "" }),
      monoState: () => ({ status: "idle" }),
    }));
    vi.doMock("../../projects/model/recents", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../projects/model/recents")>()),
      loadRecents: () => [{ path: "/work/p" }],
      loadPinnedProjects: () => [],
    }));
    const { mobileCatalog } = await import("./mobileWorkspace");
    const live = [
      { ...newSession("claude", "/work/p"), id: "live-private", private: true },
      { ...newSession("claude", "/work/p"), id: "live-open" },
    ];
    const catalog = await mobileCatalog(live as never);
    const ids = catalog.sessions.map((session) => session.id).sort();
    expect(ids).toEqual(["live-open", "saved-open"]);
    vi.doUnmock("../../sessions/data/sessionStore");
    vi.doUnmock("../../monos/model/mono");
    vi.doUnmock("../../projects/model/recents");
  });
});
