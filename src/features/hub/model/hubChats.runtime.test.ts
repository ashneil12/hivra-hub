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
  // Never silent: the thread says which Mono couldn't answer and why, and nothing is made up.
  const notice = chat.getChat(c.id)!.conversations[0].messages.at(-1)!;
  expect(notice).toMatchObject({ from: "app", kind: "notice", text: "lead couldn't answer: Provider is unavailable", notice: { mono: "lead", retry: true } });
  expect(chat.getChat(c.id)!.conversations[0].messages.filter((m) => m.from === "lead")).toHaveLength(0);
  chat.setGroupChatRunner(async () => "Recovered");
  await chat.retryNotice(c.id, notice.id);
  expect(chat.replyProblem(c.id)).toBeUndefined();
  expect(chat.getChat(c.id)!.conversations[0].messages.map((m) => m.from)).toEqual(["ash", "app", "lead"]);
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
it("keeps no file path from an imported room: the message stays and says its files are not here", async () => {
  const chat = await import("./hubChats");
  const file = (name: string, path: unknown) => ({ id: name, name, mimeType: "application/octet-stream", kind: "file", size: 3, path });
  const imported = {
    id: "theirs",
    projectId: "qa",
    name: "Theirs",
    isDefault: false,
    memberIds: [],
    conversations: [{
      id: "c1",
      when: "Today",
      title: "Look at this",
      messages: [
        { id: "m1", from: "ash", kind: "ash", text: "Please read these", attachments: [file("id_rsa", "/Users/someone/.ssh/id_rsa"), file("shot.png", "/Users/someone/Desktop/shot.png")] },
        { id: "m2", from: "ash", kind: "ash", text: "", attachments: [file("passwd", "/etc/passwd")] },
        { id: "m3", from: "ash", kind: "ash", text: "odd", attachments: "/etc/shadow" },
        { id: "m4", from: "lead", kind: "mono", text: "Nothing attached here" },
      ],
    }],
  };
  expect(chat.importChats([imported as never])).toEqual({ chats: 1, conversations: 1 });
  const messages = chat.getChat("theirs")!.conversations[0].messages;
  expect(JSON.stringify(messages)).not.toMatch(/\/Users\/someone|\/etc\/(passwd|shadow)|"path"/);
  expect(messages.map((m) => m.attachments)).toEqual([undefined, undefined, undefined, undefined]);
  expect(messages[0].text).toBe("Please read these\n\n[Attached: id_rsa, shot.png. The files are not on this Mac.]");
  expect(messages[1].text).toBe("[Attached: passwd. The files are not on this Mac.]");
  expect(messages[2].text).toBe("odd");
  expect(messages[3].text).toBe("Nothing attached here");
  expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
});
it("holds a conversation merged into a room that is here to the same rule", async () => {
  const chat = await import("./hubChats");
  const here = chat.createChat("qa", "Here", []);
  const incoming = { ...chat.getChat(here.id)!, conversations: [{
    id: "added", when: "Today", title: "Added",
    messages: [{ id: "x", from: "ash", kind: "ash", text: "see", attachments: [{ id: "a", name: "a.txt", mimeType: "text/plain", kind: "file", size: 1, path: "/Users/someone/a.txt" }] }],
  }] };
  expect(chat.importChats([incoming as never], { mergeConversations: true }).conversations).toBe(1);
  const added = chat.getChat(here.id)!.conversations.find((c) => c.id === "added")!;
  expect(JSON.stringify(added)).not.toContain("/Users/someone");
  expect(added.messages[0].attachments).toBeUndefined();
  expect(added.messages[0].text).toContain("a.txt");
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
  const notice = chat.getChat(c.id)!.conversations.find((x) => x.id === a)!.messages.at(-1)!;
  const b = chat.startConversation(c.id, "Do not repeat this other request");
  expect(chat.replyProblem(c.id, b)).toBeUndefined();
  const run = vi.fn(async (_id: string, _prompt: string) => "Recovered A"); chat.setGroupChatRunner(run);
  await chat.retryNotice(c.id, notice.id);
  expect(run.mock.calls[0][1]).toContain("Original failed request");
  expect(run.mock.calls[0][1]).not.toContain("Do not repeat this other request");
  expect(chat.getChat(c.id)!.conversations.find((x) => x.id === b)!.messages).toHaveLength(1);
});

it("keeps the newest 500 messages of each conversation on disk", async () => {
  let chat = await import("./hubChats");
  const c = chat.createChat("qa", "Busy room", []);
  const id = chat.startConversation(c.id, "message 0");
  for (let i = 1; i < 520; i++) chat.sendMessage(c.id, `message ${i}`, id);
  // The window keeps the newest 500 and knows there are more (the app database keeps them all).
  expect(chat.getChat(c.id)!.conversations[0].messages).toHaveLength(500);
  expect(chat.getChat(c.id)!.conversations[0].more).toBe(true);
  vi.resetModules();
  chat = await import("./hubChats");
  const kept = chat.getChat(c.id)!.conversations[0].messages;
  expect(kept).toHaveLength(500);
  expect(kept[0].text).toBe("message 20");
  expect(kept.at(-1)!.text).toBe("message 519");
});

it("says once when the chats couldn't be saved, and clears it when a save works", async () => {
  const chat = await import("./hubChats");
  const c = chat.createChat("qa", "Room", []);
  const setItem = vi.spyOn(localStorage, "setItem").mockImplementation((key) => {
    if (key === "monocode:hub-chats") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  chat.sendMessage(c.id, "first");
  chat.sendMessage(c.id, "second");
  expect(chat.chatSaveProblem()).toBe(
    "Group chats couldn't be saved (The quota has been exceeded). New messages may be gone after a restart.",
  );
  expect(error).toHaveBeenCalledTimes(1);
  setItem.mockRestore();
  error.mockRestore();
  chat.sendMessage(c.id, "third");
  expect(chat.chatSaveProblem()).toBeUndefined();
});
