import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSession } from "./sessionStore";
import { newSession, type Session } from "../model/session";
import { collectWorkspaceSnapshot, hydrateWorkspaceSnapshot } from "../../workspace/model/workspaceSnapshot";
import { newTab } from "../../workspace/model/layout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const record = (harness: string, model: string) => ({
  id: "s1",
  cwd: "/tmp/a",
  harness,
  model,
  modelSettings: {},
  runtimeMode: "default",
  title: "old chat",
  blocks: [],
});

beforeEach(() => vi.mocked(invoke).mockReset());

// A stored Claude model is read back as itself. Nothing is rewritten on load.
describe("chats saved with claude:sonnet-5", () => {
  it("read back as the model that was saved", async () => {
    vi.mocked(invoke).mockResolvedValue(record("claude", "claude:sonnet-5"));
    expect((await readSession("s1"))?.model).toBe("claude:sonnet-5");
  });

  it("leave other harnesses and a DeepSeek id alone", async () => {
    vi.mocked(invoke).mockResolvedValue(record("codex", "codex:gpt-5.6-sol"));
    expect((await readSession("s1"))?.model).toBe("codex:gpt-5.6-sol");
    vi.mocked(invoke).mockResolvedValue(record("claude", "claude:deepseek-v4.1-flash"));
    expect((await readSession("s1"))?.model).toBe("claude:deepseek-v4.1-flash");
  });

  it("restore from the workspace snapshot as saved", () => {
    const session: Session = { ...newSession("claude", "/tmp/a"), id: "s9", model: "claude:sonnet-5" };
    session.blocks = [{ id: "u1", role: "user", text: "hello" }];
    const tab = newTab(session.id);
    const snapshot = collectWorkspaceSnapshot([tab], [session], tab.id, session.cwd, new Map());
    const restored = hydrateWorkspaceSnapshot(snapshot, new Map(), new Set([session.id]))?.sessions[0];
    expect(restored?.model).toBe("claude:sonnet-5");
  });
});
