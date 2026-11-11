import { describe, expect, it, vi } from "vitest";
import { newDefaultSession, newSession } from "../../sessions/model/session";
import { applyMobileChoice, applyMobileConfigure, mobileConfigureMode, mobileQuestionReply } from "./mobileWorkspace";

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

describe("a new chat from the phone takes the stricter of the default and the pick (WP-175)", () => {
  it("does not loosen the default when the phone asks for more access", () => {
    const session = newDefaultSession("~", "supervised");
    expect(applyMobileChoice(session, { runtimeMode: "full-access" }).runtimeMode).toBe("supervised");
  });

  it("tightens the default when the phone asks for less access", () => {
    const session = newDefaultSession("~", "full-access");
    expect(applyMobileChoice(session, { runtimeMode: "auto" }).runtimeMode).toBe("auto");
  });

  it("keeps the default when the phone sends no mode", () => {
    const session = newDefaultSession("~", "auto-accept-edits");
    expect(applyMobileChoice(session, {}).runtimeMode).toBe("auto-accept-edits");
  });
});

describe("the phone's configure call for an open chat (WP-175 MED 4 and the App wiring)", () => {
  it("returns an error when the pick is looser, so the phone resets its pick", () => {
    const result = mobileConfigureMode({ harness: "claude", runtimeMode: "supervised" }, "supervised", { runtimeMode: "full-access" });
    expect(result.mode).toBeUndefined();
    expect(result.error).toMatch(/can only tighten this chat's mode/);
    expect(result.error).toMatch(/stays on Supervised/);
  });

  it("uses the CLI's own name in that error (Antigravity Auto is its default)", () => {
    const result = mobileConfigureMode({ harness: "antigravity", runtimeMode: "auto" }, "auto", { runtimeMode: "auto-accept-edits" });
    expect(result.error).toMatch(/stays on Default \(no AI review\)/);
  });

  it("applies a stricter pick", () => {
    expect(mobileConfigureMode({ harness: "claude", runtimeMode: "full-access" }, "full-access", { runtimeMode: "auto" })).toEqual({
      targetHarness: "claude",
      mode: "auto",
    });
  });

  it("does nothing to the mode when the phone sends none", () => {
    expect(mobileConfigureMode({ harness: "claude", runtimeMode: "auto" }, "auto", {})).toEqual({ targetHarness: "claude" });
  });

  it("leaving fx starts from Supervised, so fx's Full access never carries to another CLI", () => {
    const result = mobileConfigureMode({ harness: "fx", runtimeMode: "full-access" }, "full-access", {
      harness: "claude",
      runtimeMode: "full-access",
    });
    expect(result.targetHarness).toBe("claude");
    expect(result.error).toMatch(/stays on Supervised/);
  });

  it("takes a pick on the new CLI's ranks when leaving fx for a stricter one", () => {
    expect(
      mobileConfigureMode({ harness: "fx", runtimeMode: "full-access" }, "full-access", { harness: "claude", runtimeMode: "supervised" }),
    ).toEqual({ targetHarness: "claude", mode: "supervised" });
  });
});

describe("a new Antigravity chat from the phone takes the CLI's rank (WP-175 HIGH)", () => {
  it("does not loosen Auto to auto-accept edits on Antigravity", () => {
    const session = newDefaultSession("~", "auto");
    session.harness = "antigravity";
    expect(applyMobileChoice(session, { runtimeMode: "auto-accept-edits" }).runtimeMode).toBe("auto");
  });
});

describe("App's session.configure, run through applyMobileConfigure (WP-175 MED 4)", () => {
  const deps = () => ({
    openMode: vi.fn(() => "supervised" as const),
    onModelChange: vi.fn(),
    onModelSettingsChange: vi.fn(),
    onRuntimeModeChange: vi.fn(),
  });

  it("a looser pick throws the error and changes nothing: no model switch, no settings, no mode", () => {
    const session = newDefaultSession("~", "supervised");
    session.harness = "claude";
    const d = deps();
    expect(() =>
      applyMobileConfigure(session, { runtimeMode: "full-access", harness: "codex", model: "codex:gpt", modelSettings: { effort: "high" } }, d),
    ).toThrow(/can only tighten this chat's mode\. It stays on Supervised\./);
    expect(d.onModelChange).not.toHaveBeenCalled();
    expect(d.onModelSettingsChange).not.toHaveBeenCalled();
    expect(d.onRuntimeModeChange).not.toHaveBeenCalled();
  });

  it("a stricter pick applies the mode and returns the session", () => {
    const session = newDefaultSession("~", "full-access");
    session.harness = "claude";
    const d = deps();
    d.openMode.mockReturnValue("full-access");
    expect(applyMobileConfigure(session, { runtimeMode: "auto" }, d)).toEqual({ sessionId: session.id });
    expect(d.onRuntimeModeChange).toHaveBeenCalledWith(session.id, "auto");
  });

  it("with no pick, only the model moves", () => {
    const session = newDefaultSession("~", "auto");
    session.harness = "claude";
    const d = deps();
    applyMobileConfigure(session, { harness: "claude", model: "claude:sonnet" }, d);
    expect(d.onModelChange).toHaveBeenCalledWith(session.id, "claude", "claude:sonnet");
    expect(d.onRuntimeModeChange).not.toHaveBeenCalled();
  });
});
