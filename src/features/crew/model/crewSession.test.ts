// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMono, saveMonoSessionId } from "../../monos/model/mono";
import { crewLaunch, isCrewSession } from "./crewSession";

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
});

describe("which chats belong to a crew", () => {
  it("a plain chat in someone's own project is not a crew chat", () => {
    expect(isCrewSession({ id: "chat-1" }, [])).toBe(false);
    expect(crewLaunch({ id: "chat-1" }, [])).toEqual({});
    // A row for another chat does not make this one a worker.
    expect(isCrewSession({ id: "chat-1" }, [{ childSession: "chat-2" }])).toBe(false);
  });

  it("a Mono's chat is a crew chat even before the flag is stored", () => {
    const mono = createMono(["/work/My Project"]);
    saveMonoSessionId(mono.id, "mono-chat");
    expect(crewLaunch({ id: "mono-chat" }, [])).toEqual({ crew: true });
    expect(crewLaunch({ id: "someone-else" }, [])).toEqual({});
  });

  it("a coding team chat is one", () => {
    expect(crewLaunch({ id: "team-chat", firstMate: true }, [])).toEqual({ crew: true });
  });

  it("a worker is one, whether the app started it for a lead or a Mono delegated to it", () => {
    expect(crewLaunch({ id: "w1", orchestrationLeadId: "lead-1" }, [])).toEqual({ crew: true });
    expect(crewLaunch({ id: "w2" }, [{ childSession: "w2" }])).toEqual({ crew: true });
  });
});
