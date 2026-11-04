import { afterEach, beforeAll, describe, expect, it } from "vitest";

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, String(value));
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
if (typeof globalThis.window === "undefined") Object.assign(globalThis, { window: globalThis });

type MonoRow = {
  id: string;
  sessionId?: string;
  name?: string;
  mascot: string;
  color: string;
  projects: string[];
  roomSessions?: Record<string, string>;
};

function roster(monos: MonoRow[]) {
  memory.set("monocode:mono-roster", JSON.stringify(monos));
}

const ada: MonoRow = {
  id: "ada",
  sessionId: "sessada",
  name: "Ada",
  mascot: "fox",
  color: "hsl(20 80% 60%)",
  projects: [],
  roomSessions: { room: "roomada" },
};

let browserAgentFor: (sessionId: string | undefined) => { id: string; name: string };
let agentKey: (kind: "mono" | "team" | "chat", raw: string) => string;
let noteCodingTeamChat: (chatId: string, projectId: string) => void;
let forgetCodingTeamChat: (chatId: string) => void;
let resetCodingTeamChats: () => void;
let defaultMonoName: (mascot: string) => string;

beforeAll(async () => {
  roster([ada]);
  ({ browserAgentFor, agentKey } = await import("./agent"));
  ({ noteCodingTeamChat, forgetCodingTeamChat, resetCodingTeamChats } = await import("../../hub/model/codingTeam"));
  ({ defaultMonoName } = await import("../../monos/model/mono"));
});

afterEach(() => {
  forgetCodingTeamChat("leadchat");
  resetCodingTeamChats();
  memory.clear();
  roster([ada]);
});

describe("browserAgentFor", () => {
  it("gives one Mono's own chat and its workers the same profile", () => {
    expect(browserAgentFor("sessada")).toEqual({ id: "mono-ada", name: "Ada" });
    expect(browserAgentFor("app-sessada-job").id).toBe("mono-ada");
    expect(browserAgentFor("app-roomada-job").id).toBe("mono-ada");
    expect(browserAgentFor("app-app-sessada-job").id).toBe("mono-ada");
  });

  it("picks the longest matching session when two could fit", () => {
    roster([
      { id: "short", sessionId: "ab", mascot: "fox", color: "c", projects: [], name: "Short" },
      { id: "long", sessionId: "abc", mascot: "fox", color: "c", projects: [], name: "Long" },
    ]);
    expect(browserAgentFor("app-abc-job").id).toBe("mono-long");
    expect(browserAgentFor("app-ab-job").id).toBe("mono-short");
  });

  it("does not share a profile with a different chat", () => {
    expect(browserAgentFor("someone-else").id).toBe("chat-someone-else");
    expect(browserAgentFor("someone-else").id).not.toBe(browserAgentFor("sessada").id);
  });

  it("shares a coding team's profile with the worker it started", () => {
    noteCodingTeamChat("leadchat", "exo");
    expect(browserAgentFor("leadchat").id).toBe("team-exo");
    expect(browserAgentFor("app-leadchat-job").id).toBe("team-exo");
    expect(browserAgentFor("leadchat").name).toBe("Coding team");
    forgetCodingTeamChat("leadchat");
    expect(browserAgentFor("leadchat").id).toBe("chat-leadchat");
  });

  it("encodes a path so the profile id cannot leave its folder", () => {
    const id = browserAgentFor("../a\\b café").id;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.length).toBeLessThanOrEqual(120);
    expect(id.includes("..")).toBe(false);
    expect(id).toContain("_2e");
    expect(id).toContain("_2f");
    expect(id).toContain("_5c");
    expect(agentKey("chat", "a".repeat(200)).length).toBeLessThanOrEqual(120);
  });

  it("falls back when there is no chat", () => {
    expect(browserAgentFor(undefined).id).toBe("chat-unknown");
    expect(browserAgentFor("").id).toBe("chat-unknown");
    expect(browserAgentFor("   ").id).toBe("chat-unknown");
  });

  it("does not give two long chats the same profile", () => {
    const left = agentKey("chat", "a".repeat(200));
    const right = agentKey("chat", `${"a".repeat(199)}b`);
    expect(left).not.toBe(right);
    expect(left.length).toBeLessThanOrEqual(120);
    expect(right.length).toBeLessThanOrEqual(120);
    expect(left).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(right).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not share a profile when reading the roster throws", () => {
    const original = Array.prototype.filter;
    Array.prototype.filter = () => {
      throw new Error("roster unavailable");
    };
    let left: { id: string; name: string };
    let right: { id: string; name: string };
    try {
      left = browserAgentFor("chat-a");
      right = browserAgentFor("chat-b");
    } finally {
      Array.prototype.filter = original;
    }
    expect(left.id).not.toBe(right.id);
    expect(left.id).not.toBe("chat-unknown");
    expect(right.id).not.toBe("chat-unknown");
    expect(left.name).toBe("This chat");
  });

  it("uses the Mono's stand-in name when it has none", () => {
    roster([{ id: "noname", sessionId: "sessnoname", mascot: "wisp", color: "c", projects: [] }]);
    expect(browserAgentFor("sessnoname").name).toBe(defaultMonoName("wisp"));
    expect(browserAgentFor("sessnoname").id).toBe("mono-noname");
  });
});
