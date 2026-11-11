// WP-134b. The More agents copy the chat screens read, and the chat links kept in browser storage.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadMoreAgents: vi.fn(),
  subscribeMoreAgents: vi.fn(() => () => undefined),
  stopMoreAgentRuns: vi.fn(),
}));

vi.mock("../../../integrations/harness/moreAgents/moreAgentAdapter", () => ({
  stopMoreAgentRuns: mocks.stopMoreAgentRuns,
}));

vi.mock("../../providers/model/moreAgents", () => ({
  loadMoreAgents: mocks.loadMoreAgents,
  subscribeMoreAgents: mocks.subscribeMoreAgents,
}));

import {
  REGISTRY_CHAT_LINKS_KEY,
  START_REGISTRY_CHAT_EVENT,
  linkRegistryChat,
  loadRegistryDocument,
  moveRegistryChatLinks,
  refreshRegistry,
  registryAgentIdForSession,
  requestRegistryChat,
  unlinkRegistryChat,
} from "./registryList";

function memoryStore() {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (key: string) => raw.get(key) ?? null,
    setItem: (key: string, value: string) => raw.set(key, value),
  };
}

const usable = (id: string) => ({
  usable: true as const,
  entry: { id, name: id.toUpperCase(), command: `/opt/${id}`, args: ["acp"], protocol: "acp-v1" as const, abilities: {} },
  raw: { id },
});

describe("refreshRegistry", () => {
  beforeEach(() => mocks.loadMoreAgents.mockReset());

  it("keeps each usable entry with whether the person allowed it, and the skipped rows with their reason", async () => {
    mocks.loadMoreAgents.mockResolvedValue({
      revision: 4,
      rows: [usable("copilot"), usable("aider"), { usable: false, name: "Nope", reason: "Bad id." }],
      approved: ["aider"],
    });
    await refreshRegistry();
    const doc = loadRegistryDocument();
    expect(doc.readable).toBe(true);
    expect(doc.rev).toBe(4);
    expect(doc.agents.map((agent) => [agent.id, agent.approved])).toEqual([
      ["copilot", false],
      ["aider", true],
    ]);
    expect(doc.rejected).toEqual([{ index: 2, label: "Nope", reason: "Bad id." }]);
  });

  it("keeps the last copy when the app cannot be read, and says so", async () => {
    mocks.loadMoreAgents.mockResolvedValueOnce({ revision: 1, rows: [usable("copilot")], approved: [] });
    await refreshRegistry();
    mocks.loadMoreAgents.mockRejectedValueOnce(new Error("unreadable"));
    await refreshRegistry();
    const doc = loadRegistryDocument();
    expect(doc.readable).toBe(false);
    expect(doc.agents.map((agent) => agent.id)).toEqual(["copilot"]);
  });
});

describe("chat links", () => {
  it("links a chat to its entry and reads it back", () => {
    const store = memoryStore();
    expect(linkRegistryChat("chat-1", "copilot", store)).toEqual({ ok: true });
    expect(registryAgentIdForSession("chat-1", store)).toBe("copilot");
    expect(JSON.parse(store.raw.get(REGISTRY_CHAT_LINKS_KEY) ?? "{}")).toEqual({ "chat-1": "copilot" });
  });

  it("refuses a chat id or an entry id that is not a plain id, and stores nothing", () => {
    const store = memoryStore();
    expect(linkRegistryChat("chat 1", "copilot", store).ok).toBe(false);
    expect(linkRegistryChat("chat-1", "../copilot", store).ok).toBe(false);
    expect(store.raw.has(REGISTRY_CHAT_LINKS_KEY)).toBe(false);
  });

  it("drops a damaged link entry on read and removes a link on unlink", () => {
    const store = memoryStore();
    store.raw.set(REGISTRY_CHAT_LINKS_KEY, JSON.stringify({ "chat-1": "copilot", "chat-2": "Not A Slug" }));
    expect(registryAgentIdForSession("chat-2", store)).toBeUndefined();
    expect(registryAgentIdForSession("chat-1", store)).toBe("copilot");
    unlinkRegistryChat("chat-1", store);
    expect(registryAgentIdForSession("chat-1", store)).toBeUndefined();
  });

  it("moves each browser link onto the row once, and keeps a link whose write failed", async () => {
    const raw = new Map<string, string>([
      [REGISTRY_CHAT_LINKS_KEY, JSON.stringify({ "chat-1": "my-copilot", "chat-2": "other-agent", "chat-3": "gone-agent" })],
    ]);
    const store = {
      raw,
      getItem: (key: string) => raw.get(key) ?? null,
      setItem: (key: string, value: string) => raw.set(key, value),
      removeItem: (key: string) => raw.delete(key),
    };
    const adopted: [string, string][] = [];
    await moveRegistryChatLinks(async (sessionId, agentId) => {
      adopted.push([sessionId, agentId]);
      if (sessionId === "chat-2") throw new Error("locked");
      return sessionId !== "chat-3";
    }, store);
    expect(adopted).toEqual([
      ["chat-1", "my-copilot"],
      ["chat-2", "other-agent"],
      ["chat-3", "gone-agent"],
    ]);
    // chat-1 was written. chat-3 had no row, so its link is dropped. chat-2's write failed, so it stays for the next start.
    expect(JSON.parse(store.getItem(REGISTRY_CHAT_LINKS_KEY) ?? "{}")).toEqual({ "chat-2": "other-agent" });
    await moveRegistryChatLinks(async () => true, store);
    expect(store.getItem(REGISTRY_CHAT_LINKS_KEY)).toBeNull();
  });

  // Review #231 r2 repro (MEDIUM): the move deletes the browser links once they are on the row, but the build before
  // this one (main at 87b454020) reads only the browser links (sessionStore.ts registryAgentIdForSession). A ship whose
  // trial fails puts that build and the database copy from before the ship back by itself, and hub:rollback does the
  // same by hand; both share this webview storage (same identifier). After either, every More agents chat has no link
  // anywhere: the old build treats it as the placeholder Claude chat (its next message starts Claude Code with the
  // agent's conversation, and binds the ACP session id to Claude), and the next ship has nothing left to move. The
  // links should stay for an older build to read (the row is still what this build trusts; adoption only fills an
  // empty column, so keeping them also heals a restored database on the next start).
  it("leaves the browser links readable for an older build after moving them onto the row", async () => {
    const raw = new Map<string, string>([
      [REGISTRY_CHAT_LINKS_KEY, JSON.stringify({ "chat-1": "my-copilot" })],
    ]);
    const store = {
      raw,
      getItem: (key: string) => raw.get(key) ?? null,
      setItem: (key: string, value: string) => raw.set(key, value),
      removeItem: (key: string) => raw.delete(key),
    };
    await moveRegistryChatLinks(async () => true, store);
    // What the older build's readSession calls.
    expect(registryAgentIdForSession("chat-1", store)).toBe("my-copilot");
  });
});

describe("requestRegistryChat", () => {
  it("asks for a chat with an entry id and a folder, and nothing else", () => {
    const target = new EventTarget();
    const heard: unknown[] = [];
    target.addEventListener(START_REGISTRY_CHAT_EVENT, (event) => heard.push((event as CustomEvent).detail));
    requestRegistryChat("copilot", { enabled: true, cwd: "/repo", target: target as unknown as Window });
    requestRegistryChat("copilot", { enabled: false, target: target as unknown as Window });
    expect(heard).toEqual([{ agentId: "copilot", cwd: "/repo" }]);
  });
});

describe("a withdrawn or edited entry stops its running agent", () => {
  const row = (id: string, command: string) => ({
    usable: true,
    entry: { id, name: id, command, args: ["--acp"], protocol: "acp-v1" },
    raw: { id },
  });

  it("stops the run when the list no longer allows it, and when its command changes", async () => {
    mocks.loadMoreAgents.mockResolvedValueOnce({ revision: 0, rows: [], approved: [], fingerprints: {}, resolved: {} });
    await refreshRegistry();
    mocks.stopMoreAgentRuns.mockClear();
    mocks.loadMoreAgents.mockResolvedValueOnce({
      revision: 1,
      rows: [row("copilot", "/opt/copilot")],
      approved: ["copilot"],
      fingerprints: { copilot: "fp-1" },
      resolved: { copilot: "/opt/copilot" },
    });
    await refreshRegistry();
    expect(mocks.stopMoreAgentRuns).not.toHaveBeenCalled();

    mocks.loadMoreAgents.mockResolvedValueOnce({
      revision: 2,
      rows: [row("copilot", "/opt/copilot")],
      approved: [],
      fingerprints: { copilot: "fp-1" },
      resolved: { copilot: "/opt/copilot" },
    });
    await refreshRegistry();
    expect(mocks.stopMoreAgentRuns).toHaveBeenCalledWith("copilot");
  });
});

