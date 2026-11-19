// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { chatListScope, inChatListScope, resetChatListScope, setChatListScope } from "./chatListScope";

afterEach(() => resetChatListScope());

const monos: Record<string, string> = { "lead-main": "exo-lead", "lead-side": "exo-lead", "chief-project": "chief", "chief-side": "chief" };
const started: Record<string, string> = { "lead-worker": "lead-main", "lead-worker-helper": "lead-worker", "chief-worker": "chief-side", loop: "loop" };
const facts = { monoOf: (id: string) => monos[id], startedBy: (id: string) => started[id] };
const lead = { monoId: "exo-lead", plainChats: true };
const chief = { monoId: "chief", plainChats: false };

it("a first mate's list keeps its own chats and leaves out another first mate's", () => {
  expect(inChatListScope("own", lead, "lead-side", facts)).toBe(true);
  expect(inChatListScope("own", lead, "chief-side", facts)).toBe(false);
  expect(inChatListScope("own", chief, "chief-side", facts)).toBe(true);
  expect(inChatListScope("own", chief, "lead-side", facts)).toBe(false);
});

it("a chat a first mate's chat started belongs to that first mate, however far down", () => {
  expect(inChatListScope("own", lead, "lead-worker-helper", facts)).toBe(true);
  expect(inChatListScope("own", chief, "lead-worker-helper", facts)).toBe(false);
  expect(inChatListScope("own", lead, "chief-worker", facts)).toBe(false);
  expect(inChatListScope("own", chief, "chief-worker", facts)).toBe(true);
});

it("a chat no first mate is behind is the project's: with its Lead, not with the Chief of Staff", () => {
  expect(inChatListScope("own", lead, "plain", facts)).toBe(true);
  expect(inChatListScope("own", chief, "plain", facts)).toBe(false);
  expect(inChatListScope("own", lead, "loop", facts)).toBe(true);
});

it("Everyone lists every chat", () => {
  for (const id of ["lead-side", "chief-side", "plain", "lead-worker", "chief-worker"]) {
    expect(inChatListScope("all", chief, id, facts)).toBe(true);
    expect(inChatListScope("all", lead, id, facts)).toBe(true);
  }
});

it("starts on the first mate's own chats and keeps the choice", () => {
  expect(chatListScope()).toBe("own");
  setChatListScope("all");
  expect(chatListScope()).toBe("all");
  expect(localStorage.getItem("monocode:chat-list-scope")).toBe("all");
  setChatListScope("own");
  expect(chatListScope()).toBe("own");
  expect(localStorage.getItem("monocode:chat-list-scope")).toBeNull();
});
