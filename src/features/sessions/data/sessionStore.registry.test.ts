// WP-134b. A saved More agents chat reads back as a chat of its agent. Its stored harness is still one of the eleven,
// and a registry id is never read through asHarness (which turns an unknown id into Cursor).

import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSession, sanitizeSessionForPersist } from "./sessionStore";
import { REGISTRY_CHAT_LINKS_KEY } from "../../registry/model/registryList";
import { bindResumedSessions } from "../../../app/model/appLifecycle";
import { registerHarness, type HarnessAdapter } from "../../../integrations/harness/core/registry";
import { newSession } from "../model/session";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const record = (id: string, harness: string) => ({
  id,
  cwd: "/tmp/a",
  harness,
  model: "claude:sonnet-5",
  modelSettings: {},
  runtimeMode: "default",
  title: "a chat",
  blocks: [],
});

function installStorage(links: Record<string, string> | null) {
  const raw = new Map<string, string>();
  if (links) raw.set(REGISTRY_CHAT_LINKS_KEY, JSON.stringify(links));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => raw.get(key) ?? null,
    setItem: (key: string, value: string) => raw.set(key, value),
    removeItem: (key: string) => raw.delete(key),
  });
}

beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("a saved More agents chat", () => {
  it("reads its agent id from the session row, not from browser storage", async () => {
    installStorage({ "chat-1": "from-browser" });
    vi.mocked(invoke).mockResolvedValue({
      ...record("chat-1", "claude"),
      registryAgentId: "my-copilot",
    });
    const session = await readSession("chat-1");
    expect(session?.registryAgentId).toBe("my-copilot");
    expect(session?.harness).toBe("claude");
  });

  it("does not use a leftover browser link when the row has none", async () => {
    installStorage({ "chat-1": "my-copilot" });
    vi.mocked(invoke).mockResolvedValue(record("chat-1", "claude"));
    const session = await readSession("chat-1");
    expect(session?.registryAgentId).toBeUndefined();
    expect(session?.harness).toBe("claude");
  });

  it("still knows its agent after the agent was removed from the list", async () => {
    installStorage({});
    vi.mocked(invoke).mockResolvedValue({
      ...record("chat-1", "claude"),
      registryAgentId: "my-copilot",
    });
    const session = await readSession("chat-1");
    expect(session?.registryAgentId).toBe("my-copilot");
  });

  it("does not make a chat of the eleven into a More agents chat", async () => {
    installStorage({ "chat-2": "my-copilot" });
    vi.mocked(invoke).mockResolvedValue(record("chat-2", "codex"));
    const session = await readSession("chat-2");
    expect(session?.registryAgentId).toBeUndefined();
    expect(session?.harness).toBe("codex");
  });

  it("never reads a registry id as a harness: an unknown stored id is not the agent", async () => {
    installStorage({});
    vi.mocked(invoke).mockResolvedValue(record("chat-3", "my-copilot"));
    const session = await readSession("chat-3");
    // The existing rule for an unknown id. It must not turn into a link to the agent.
    expect(session?.harness).toBe("cursor");
    expect(session?.registryAgentId).toBeUndefined();
  });

  it("does not route a harness id stored in the entry column", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...record("chat-1", "claude"),
      registryAgentId: "claude",
    });
    const session = await readSession("chat-1");
    expect(session?.registryAgentId).toBeUndefined();
    expect(session?.harness).toBe("claude");
  });

  it("reads a chat normally when the list cannot be read", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    });
    vi.mocked(invoke).mockResolvedValue({
      ...record("chat-1", "claude"),
      registryAgentId: "my-copilot",
    });
    const session = await readSession("chat-1");
    expect(session?.registryAgentId).toBe("my-copilot");
    expect(session?.harness).toBe("claude");
  });

  it("writes the entry id with the chat, and not a harness id", () => {
    const session = {
      ...newSession("claude", "/tmp/a"),
      registryAgentId: "my-copilot",
      blocks: [{ id: "b1", role: "user" as const, text: "hi" }],
    };
    expect(sanitizeSessionForPersist(session).registryAgentId).toBe("my-copilot");
    const { registryAgentId: _dropped, ...plain } = session;
    expect(sanitizeSessionForPersist(plain).registryAgentId).toBeUndefined();
    expect(
      sanitizeSessionForPersist({ ...session, registryAgentId: "claude" }).registryAgentId,
    ).toBeUndefined();
    expect(
      sanitizeSessionForPersist({ ...session, registryAgentId: "../x" }).registryAgentId,
    ).toBeUndefined();
  });

  it("routes a restored chat from the row before the harness bind", async () => {
    const bindSession = vi.fn();
    registerHarness({
      id: "claude",
      live: true,
      bindSession,
      sendTurn: vi.fn(),
      cancelTurn: vi.fn(),
      respondApproval: vi.fn(),
      stopSession: vi.fn(),
      forgetSession: vi.fn(),
    } as unknown as HarnessAdapter);
    vi.mocked(invoke).mockResolvedValue({
      ...record("chat-1", "claude"),
      registryAgentId: "gemini-acp",
      providerSessionId: "acp-session-1",
      cwd: "/tmp/a",
    });
    const session = await readSession("chat-1");
    expect(session?.registryAgentId).toBe("gemini-acp");
    bindResumedSessions([session!]);
    expect(bindSession).not.toHaveBeenCalled();
  });
});
