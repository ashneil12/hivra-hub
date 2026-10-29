// @vitest-environment happy-dom
// r67 (S8 on the 0.16.9 dev copy): frank chimed in unasked, streamed "Ash locked two calls. I'll check they're actually
// in Tally's memory before I say anything.", checked, and ended on NO_REPLY; the room still got "Ash locked two calls."
// A seat that chimed in and narrated its way to NO_REPLY posts nothing: its lead-in goes with the narration.
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

async function room() {
  const team = await import("./builtInMonos");
  team.ensureBuiltInMonos();
  const chat = await import("./hubChats");
  const c = chat.createChat("hub", "Leadership team", ["chief-of-staff", "projects-manager", "frank", "alfred"]);
  const said = (convId: string) => chat.getChat(c.id)!.conversations.find((x) => x.id === convId)!.messages;
  return { chat, id: c.id, said };
}

it("a chime that streamed a lead-in, narrated a check and ended on NO_REPLY leaves nothing in the room", async () => {
  const { chat, id, said } = await room();
  let write!: (text: string) => void;
  let end!: (text: string) => void;
  chat.setGroupChatRunner({
    run: (request) => {
      if (request.monoId === "chief-of-staff") return Promise.resolve({ kind: "reply", text: "Locked. Median first in a worktree off main, then the weekly reset." });
      if (request.monoId !== "frank") return Promise.resolve({ kind: "reply", text: "NO_REPLY" });
      write = (text) => request.onText?.(text);
      return new Promise((resolve) => (end = (text) => resolve({ kind: "reply", text })));
    },
  });
  const conv = chat.startConversation(id, "whole team yeah, dont build sharing. median off main. then the weekly reset. ok go");
  const done = chat.requestReply(id, conv);
  await vi.waitFor(() => expect(write).toBeTypeOf("function"), { timeout: 3000 });
  const words = "Ash locked two calls. I'll check they're actually in Tally's memory before I say anything.";
  write(words);
  end(`${words}\n\nNO_REPLY`);
  await done;
  await vi.waitFor(() => expect(chat.roomDrafts(id, conv)).toEqual([]));
  expect(said(conv).filter((m) => m.from === "frank")).toEqual([]);
  expect(said(conv).some((m) => m.from === "chief-of-staff")).toBe(true);
});

it("a chime with a real fact before NO_REPLY and no narration still keeps the words Ash watched (r52)", async () => {
  const { chat, id, said } = await room();
  let write!: (text: string) => void;
  let end!: (text: string) => void;
  chat.setGroupChatRunner({
    run: (request) => {
      if (request.monoId === "chief-of-staff") return Promise.resolve({ kind: "reply", text: "Locked. Median first." });
      if (request.monoId !== "frank") return Promise.resolve({ kind: "reply", text: "NO_REPLY" });
      write = (text) => request.onText?.(text);
      return new Promise((resolve) => (end = (text) => resolve({ kind: "reply", text })));
    },
  });
  const conv = chat.startConversation(id, "ok go");
  const done = chat.requestReply(id, conv);
  await vi.waitFor(() => expect(write).toBeTypeOf("function"), { timeout: 3000 });
  const words = "The weekly reset is Monday 00:00 Europe/London, per memory line 14.";
  write(words);
  end(`${words}\n\nNO_REPLY`);
  await done;
  await vi.waitFor(() => expect(chat.roomDrafts(id, conv)).toEqual([]));
  expect(said(conv).find((m) => m.from === "frank")?.text).toBe(words);
});
