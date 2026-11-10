import { describe, expect, it, vi } from "vitest";
import { AGENT_GONE } from "./registryCopy";
import {
  LIST_UNREADABLE,
  REGISTRY_STORAGE_KEY,
  START_REGISTRY_CHAT_EVENT,
  addRegistryAgent,
  linkRegistryChat,
  loadRegistryDocument,
  parseArgLines,
  parseEnvLines,
  registryAgentIdForSession,
  removeRegistryAgent,
  requestRegistryChat,
  saveRegistryDocument,
  unlinkRegistryChat,
  type RegistryStore,
} from "./registryList";

function memory(): RegistryStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get length() {
      return raw.size;
    },
    clear: () => raw.clear(),
    getItem: (key) => raw.get(key) ?? null,
    key: (index) => [...raw.keys()][index] ?? null,
    removeItem: (key) => {
      raw.delete(key);
    },
    setItem: (key, value) => {
      raw.set(key, value);
    },
  };
}

function seed(store: RegistryStore, agents: unknown[], extra: Record<string, unknown> = {}) {
  store.setItem(
    REGISTRY_STORAGE_KEY,
    JSON.stringify({ rev: 4, agents, chats: { sess_1: "good" }, ...extra }),
  );
}

const good = {
  id: "good",
  name: "Good",
  command: "good-agent",
  args: ["acp", "hello world"],
  protocol: "acp-v1",
  env: [{ name: "MODE", value: "ask" }],
  ignored: true,
};

describe("loadRegistryDocument", () => {
  it("starts empty and does not write", () => {
    const store = memory();
    const setItem = vi.spyOn(store, "setItem");
    expect(loadRegistryDocument(store)).toEqual({
      rev: 0,
      agents: [],
      chats: {},
      rejected: [],
      readable: true,
    });
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps good entries when one entry is bad, and does not rewrite the stored list", () => {
    const store = memory();
    seed(store, [
      good,
      {
        id: "claude",
        name: "Nope",
        command: "../secret-value",
        args: [],
        protocol: "acp-v1",
        env: [{ name: "TOKEN", value: "secret-value" }],
      },
      {
        id: "second",
        name: "Second",
        command: "C:\\Program Files\\agents\\second.exe",
        args: [],
        protocol: "acp-v1",
        env: [],
      },
    ]);
    const before = store.getItem(REGISTRY_STORAGE_KEY);
    const loaded = loadRegistryDocument(store);
    expect(loaded.agents.map((agent) => agent.id)).toEqual(["good", "second"]);
    expect(loaded.agents[0]?.args).toEqual(["acp", "hello world"]);
    expect(loaded.agents[0]?.env).toEqual([{ name: "MODE", value: "ask" }]);
    expect(loaded.rejected).toEqual([
      expect.objectContaining({ index: 1, label: "Nope" }),
    ]);
    expect(JSON.stringify(loaded.rejected)).not.toContain("secret-value");
    expect(loaded.chats).toEqual({ sess_1: "good" });
    expect(loaded.rev).toBe(4);
    expect(store.getItem(REGISTRY_STORAGE_KEY)).toBe(before);
  });

  it("skips a duplicate id and an unsupported protocol without dropping the rest", () => {
    const store = memory();
    seed(store, [
      good,
      { ...good, name: "Again" },
      {
        id: "other",
        name: "Other",
        command: "other-agent",
        args: ["ok"],
        protocol: "acp-v2",
        env: [],
      },
    ]);
    const loaded = loadRegistryDocument(store);
    expect(loaded.agents.map((agent) => agent.id)).toEqual(["good"]);
    expect(loaded.rejected.map((row) => row.label)).toEqual(["Again", "Other"]);
  });

  it("does not throw when storage is missing or throws", () => {
    expect(registryAgentIdForSession("sess_1")).toBeUndefined();
    const store = memory();
    store.getItem = () => {
      throw new Error("storage unavailable");
    };
    expect(loadRegistryDocument(store).readable).toBe(false);
    expect(registryAgentIdForSession("sess_1", store)).toBeUndefined();
  });

  it("refuses to save over a list that could not be read", () => {
    const store = memory();
    store.setItem(REGISTRY_STORAGE_KEY, "{not json");
    const saved = saveRegistryDocument({ agents: [], chats: {} }, 0, store);
    expect(saved).toEqual({ ok: false, reason: "unreadable" });
    expect(store.getItem(REGISTRY_STORAGE_KEY)).toBe("{not json");
    expect(addRegistryAgent({ name: "My Copilot", command: "copilot", args: [], env: [] }, store)).toEqual({
      ok: false,
      reason: LIST_UNREADABLE,
    });
  });
});

describe("addRegistryAgent", () => {
  it("stores a local command and rejects a built-in id or a shell command", () => {
    const store = memory();
    const added = addRegistryAgent(
      {
        name: "My Copilot",
        command: "/opt/agents/copilot",
        args: ["acp", "hello world"],
        env: [
          { name: "MODE", value: "ask" },
          { name: "MONOCODE_CONTROL_TOKEN", value: "secret-value" },
        ],
      },
      store,
    );
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.reason).not.toContain("secret-value");

    const safe = addRegistryAgent(
      {
        name: "My Copilot",
        command: "/opt/agents/copilot",
        args: ["acp", "hello world"],
        env: [{ name: "MODE", value: "ask" }],
      },
      store,
    );
    expect(safe.ok).toBe(true);
    if (safe.ok) expect(safe.agent.id).toBe("my-copilot");

    const builtin = addRegistryAgent({ name: "Claude", command: "copilot", args: [], env: [] }, store);
    expect(builtin.ok).toBe(false);
    expect(loadRegistryDocument(store).agents).toHaveLength(1);

    for (const command of ["../bin/agent", "agent\r\n", "sh", "bash -c", "C:\\tools\\claude.exe", "cursor-agent"]) {
      const rejected = addRegistryAgent({ name: "Other Agent", command, args: [], env: [] }, store);
      expect(rejected.ok, command).toBe(false);
    }
    expect(loadRegistryDocument(store).agents.map((agent) => agent.command)).toEqual(["/opt/agents/copilot"]);

    const windows = addRegistryAgent(
      { name: "Window Agent", command: "C:\\Program Files\\agents\\window agent.exe", args: [], env: [] },
      store,
    );
    expect(windows.ok).toBe(true);
  });

  it("does not let a stale write wipe an agent another window added", () => {
    const store = memory();
    const first = addRegistryAgent({ name: "Alpha Agent", command: "alpha", args: [], env: [] }, store);
    expect(first.ok).toBe(true);
    const seen = loadRegistryDocument(store);
    const second = addRegistryAgent({ name: "Beta Agent", command: "beta", args: [], env: [] }, store);
    expect(second.ok).toBe(true);
    const stale = saveRegistryDocument({ agents: seen.agents, chats: {} }, seen.rev, store);
    expect(stale).toEqual({ ok: false, reason: "stale" });
    expect(loadRegistryDocument(store).agents.map((agent) => agent.id)).toEqual(["alpha-agent", "beta-agent"]);
  });

  it("keeps the chat link after the agent entry is removed", () => {
    const store = memory();
    addRegistryAgent({ name: "Alpha Agent", command: "alpha", args: [], env: [] }, store);
    const linked = linkRegistryChat("sess_1", "alpha-agent", store);
    expect(linked.ok).toBe(true);
    expect(removeRegistryAgent("alpha-agent", store).ok).toBe(true);
    expect(loadRegistryDocument(store).agents).toEqual([]);
    expect(registryAgentIdForSession("sess_1", store)).toBe("alpha-agent");
    expect(linkRegistryChat("sess_2", "alpha-agent", store)).toEqual({ ok: false, reason: AGENT_GONE });
    expect(unlinkRegistryChat("sess_1", store).ok).toBe(true);
    expect(registryAgentIdForSession("sess_1", store)).toBeUndefined();
  });

  it("retries a chat link on top of a newer revision instead of overwriting it", () => {
    const store = memory();
    addRegistryAgent({ name: "Alpha Agent", command: "alpha", args: [], env: [] }, store);
    const agents = loadRegistryDocument(store).agents;
    let reads = 0;
    const racing: RegistryStore = {
      getItem: (key) => {
        reads += 1;
        if (reads === 2) {
          store.setItem(
            REGISTRY_STORAGE_KEY,
            JSON.stringify({ rev: 2, agents, chats: { other: "alpha-agent" } }),
          );
        }
        return store.getItem(key);
      },
      setItem: (key, value) => store.setItem(key, value),
    };
    expect(linkRegistryChat("sess_1", "alpha-agent", racing).ok).toBe(true);
    expect(loadRegistryDocument(store).chats).toEqual({
      other: "alpha-agent",
      sess_1: "alpha-agent",
    });
  });
});

describe("parseArgLines", () => {
  it("keeps spaces inside an argument and drops empty lines", () => {
    expect(parseArgLines("acp\n\nhello world\r\n")).toEqual(["acp", "hello world"]);
    const parsed = parseEnvLines("MODE=ask\nMONOCODE_TOKEN=secret-value\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).not.toContain("secret-value");
    expect(parseEnvLines("MODE=a=b").ok && parseEnvLines("MODE=a=b")).toMatchObject({
      ok: true,
      env: [{ name: "MODE", value: "a=b" }],
    });
  });
});

describe("requestRegistryChat", () => {
  it("does not ask for a chat when More agents is off", () => {
    const heard = vi.fn();
    const target = {
      dispatchEvent: heard,
    } as unknown as Window;
    requestRegistryChat("my-copilot", { enabled: false, target });
    expect(heard).not.toHaveBeenCalled();
    requestRegistryChat("my-copilot", { enabled: true, target });
    expect(heard).toHaveBeenCalledTimes(1);
    const event = heard.mock.calls[0]?.[0] as CustomEvent<{ agentId: string }>;
    expect(event.type).toBe(START_REGISTRY_CHAT_EVENT);
    expect(event.detail).toEqual({ agentId: "my-copilot" });
    requestRegistryChat("my-copilot", { enabled: true, cwd: "/work/My Project", target });
    const withCwd = heard.mock.calls[1]?.[0] as CustomEvent<{ agentId: string; cwd?: string }>;
    expect(withCwd.detail).toEqual({ agentId: "my-copilot", cwd: "/work/My Project" });
    requestRegistryChat("my-copilot", { enabled: true, cwd: "/work/bad\npath", target });
    const dropped = heard.mock.calls[2]?.[0] as CustomEvent<{ agentId: string; cwd?: string }>;
    expect(dropped.detail).toEqual({ agentId: "my-copilot" });
  });
});
