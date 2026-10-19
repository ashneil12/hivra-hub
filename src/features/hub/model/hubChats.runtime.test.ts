// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
beforeEach(() => { localStorage.clear(); vi.resetModules(); });
it("uses a real seated Mono runner and retains history/membership after reloading", async () => {
  let chat = await import("./hubChats");
  const c = chat.createChat("qa", "Planning", ["lead"]);
  const id = chat.startConversation(c.id, "What is actually running?");
  const run = vi.fn(async () => "The check failed; nothing has been marked done.");
  chat.setGroupChatRunner(run);
  await chat.requestReply(c.id, id);
  expect(run).toHaveBeenCalledWith("lead", expect.stringContaining("What is actually running?"));
  expect(chat.getChat(c.id)!.conversations[0].messages.at(-1)!.text).toContain("check failed");
  expect(JSON.stringify(chat.getChat(c.id))).not.toContain("Example:");
  vi.resetModules(); chat = await import("./hubChats");
  expect(chat.getChat(c.id)!.memberIds).toEqual(["lead"]);
  expect(chat.getChat(c.id)!.conversations[0].messages).toHaveLength(2);
});
it("shows backend failure and retries the saved message without inventing a reply", async () => {
  const chat = await import("./hubChats");
  const c = chat.createChat("qa", "Broken", ["lead"]);
  const id = chat.startConversation(c.id, "Fix it");
  chat.setGroupChatRunner(async () => { throw new Error("Provider is unavailable"); });
  await chat.requestReply(c.id, id);
  expect(chat.replyProblem(c.id)).toBe("Provider is unavailable");
  expect(chat.getChat(c.id)!.conversations[0].messages).toHaveLength(1);
  chat.setGroupChatRunner(async () => "Recovered");
  await chat.requestReply(c.id, id);
  expect(chat.replyProblem(c.id)).toBeUndefined();
  expect(chat.getChat(c.id)!.conversations[0].messages).toHaveLength(2);
});
it("blocks a second dispatch while a reply is pending and does not leak membership into other groups", async () => {
  const chat = await import("./hubChats");
  const a = chat.createChat("qa", "First", ["lead"]);
  const b = chat.createChat("qa", "Second", []);
  const id = chat.startConversation(a.id, "Question");
  let finish!: (text: string) => void;
  const run = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  chat.setGroupChatRunner(run);
  const pending = chat.requestReply(a.id, id);
  await chat.requestReply(a.id, id);
  expect(run).toHaveBeenCalledTimes(1);
  expect(chat.getChat(b.id)!.memberIds).toEqual([]);
  finish("Reply"); await pending;
  expect(chat.typingIn(a.id)).toBeUndefined();
});

it("rejects malformed imported conversation records", async () => {
  const chat = await import("./hubChats");
  chat.importChats([{ id: "broken", projectId: "qa", name: "Malformed", isDefault: false } as any]);
  expect(chat.getChat("broken")).toBeUndefined();
  expect(chat.validGroupChats([{ id: "nested", projectId: "qa", name: "Nested", isDefault: true, memberIds: [], conversations: [{ id: "x", when: "Today", title: "Bad", messages: null }] }])).toEqual([]);
});
it("remembers an interrupted reply on restart rather than claiming it answered", async () => {
  const original = { id: "pending", projectId: "qa", name: "Pending", isDefault: true, memberIds: ["lead"], conversations: [], replyPending: "lead" };
  localStorage.setItem("monocode:hub-chats", JSON.stringify([original]));
  const chat = await import("./hubChats");
  expect(chat.replyProblem("pending")).toContain("interrupted");
  expect(chat.typingIn("pending")).toBeUndefined();
});

it("retries the failed conversation even after another conversation is selected", async () => {
  const chat = await import("./hubChats");
  const c = chat.createChat("qa", "Retry", ["lead"]);
  const a = chat.startConversation(c.id, "Original failed request");
  chat.setGroupChatRunner(async () => { throw new Error("Offline"); });
  await chat.requestReply(c.id, a);
  const b = chat.startConversation(c.id, "Do not repeat this other request");
  expect(chat.replyProblem(c.id, b)).toBeUndefined();
  const run = vi.fn(async (_id: string, _prompt: string) => "Recovered A"); chat.setGroupChatRunner(run);
  await chat.retryReply(c.id);
  expect(run.mock.calls[0][1]).toContain("Original failed request");
  expect(run.mock.calls[0][1]).not.toContain("Do not repeat this other request");
  expect(chat.getChat(c.id)!.conversations.find((x) => x.id === b)!.messages).toHaveLength(1);
});
