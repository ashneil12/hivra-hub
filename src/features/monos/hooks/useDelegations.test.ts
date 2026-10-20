// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMono, updateMono } from "../model/mono";
import { chatBinding } from "./useDelegations";

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("tells Ash OS which chat each Claude session is: a Lead, another Mono, a worker or a plain chat", () => {
  const lead = createMono();
  updateMono(lead.id, (mono) => ({ ...mono, id: "vg-game-lead", sessionId: "lead-chat" }));
  const other = createMono();
  updateMono(other.id, (mono) => ({ ...mono, sessionId: "frank-chat" }));
  const claude = (id: string) => ({ id, harness: "claude" as const, providerSessionId: `p-${id}` });

  expect(chatBinding(claude("lead-chat"))).toEqual({
    providerSession: "p-lead-chat",
    chatId: "lead-chat",
    monoId: "vg-game-lead",
    role: "lead",
  });
  expect(chatBinding(claude("frank-chat"))).toMatchObject({ monoId: other.id, role: "mono" });
  expect(chatBinding(claude("app-lead-chat-1"), "t-1")).toEqual({
    providerSession: "p-app-lead-chat-1",
    chatId: "app-lead-chat-1",
    role: "worker",
    delegationId: "t-1",
  });
  // Its task finished (no open row): still a worker, as its ash-os identity says.
  expect(chatBinding(claude("app-lead-chat-1"))).toEqual({
    providerSession: "p-app-lead-chat-1",
    chatId: "app-lead-chat-1",
    role: "worker",
  });
  expect(chatBinding(claude("plain"))).toEqual({ providerSession: "p-plain", chatId: "plain" });
  expect(chatBinding({ id: "codex", harness: "codex", providerSessionId: "x" })).toBeUndefined();
  expect(chatBinding({ id: "unbound", harness: "claude" })).toBeUndefined();
});
