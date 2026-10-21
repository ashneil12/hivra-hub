// @vitest-environment happy-dom
// B8 (Ash, 15 Oct 17:20): "You can't rename a new conversation at all. I don't know if it also renames itself after he
// gets the topic of the message. In general, pressing "new conversation" also shouldn't immediately create a new
// conversation. It should take you to the new conversation screen." / "The plus sign, what is it that you can attach
// anything?" The real room screen: New conversation opens a screen and backing out leaves nothing behind; a new
// conversation can be named before its first message and an old one renamed by double-click, and the name holds (the
// first message, a later one and a restart never rename it); a photo and a file go with the message and reach the Mono.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Attachment } from "../../sessions/model/session";

// The composer is a stand-in that hands GroupChatView what Ash typed and attached (MonoComposer has its own tests).
const composer = vi.hoisted(() => ({ submit: undefined as undefined | ((text: string, files: Attachment[]) => unknown) }));
vi.mock("../../monos/ui/MonoComposer", () => ({
  MonoComposer: (props: { onSubmit: (text: string, files: Attachment[]) => unknown }) => {
    composer.submit = props.onSubmit;
    return null;
  },
}));
// A pasted picture is written to a file by the app (fs.rs write_attachment).
const written = vi.hoisted(() => [] as { name: string; data: string }[]);
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string, args: { name: string; data: string }) => {
    if (cmd !== "write_attachment") throw new Error(`no ${cmd} here`);
    written.push(args);
    return `/tmp/monocode-attachments/1-2-${args.name}`;
  },
}));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  written.length = 0;
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render({ withConversation = true } = {}) {
  const team = await import("../model/builtInMonos");
  team.ensureBuiltInMonos();
  const chat = await import("../model/hubChats");
  const { GroupChatView } = await import("./GroupChatView");
  const room = chat.createChat("hub", "Leadership Board", ["chief-of-staff", "projects-manager", "frank"]);
  const first = withConversation ? chat.startConversation(room.id, "whats the plan for pages") : undefined;
  const show = () => act(() => root.render(createElement(GroupChatView, { chatId: room.id, projectId: "hub" })));
  show();
  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
  const convs = () => chat.getChat(room.id)!.conversations;
  return { chat, room, first, show, q, convs };
}

const dblclick = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
async function typeName(input: HTMLInputElement, name: string) {
  await act(async () => {
    input.value = name;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}
const send = (text: string, files: Attachment[] = []) => act(async () => void (await composer.submit!(text, files)));

it("New conversation opens a screen; Back and Escape leave it, and no empty conversation is left behind", async () => {
  const { q, convs, chat, room } = await render();
  expect(convs()).toHaveLength(1);
  act(() => q("[data-hub-new-conversation]")!.click());
  expect(q("[data-hub-new-conversation-screen]")).toBeTruthy();
  expect(convs()).toHaveLength(1);
  // Back returns to the conversation he was in, and nothing was made.
  act(() => q("[data-hub-new-conversation-back]")!.click());
  expect(q("[data-hub-new-conversation-screen]")).toBeNull();
  expect(q("[data-hub-conversation-draft]")).toBeNull();
  expect(q("[data-hub-conversation-title]")!.textContent).toBe("whats the plan for pages");
  // Escape backs out too.
  act(() => q("[data-hub-new-conversation]")!.click());
  act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(q("[data-hub-new-conversation-screen]")).toBeNull();
  expect(convs()).toHaveLength(1);
  // Nothing reached the store either (the window's storage here; the app database writes the same records).
  const stored = JSON.parse(localStorage.getItem("monocode:hub-chats")!) as { id: string; conversations: unknown[] }[];
  expect(stored.find((c) => c.id === room.id)!.conversations).toHaveLength(1);
  expect(chat.getChat(room.id)!.conversations.every((c) => c.messages.length > 0)).toBe(true);
});

it("a new conversation can be named before its first message, and that message doesn't rename it", async () => {
  const { q, convs, chat, room } = await render();
  act(() => q("[data-hub-new-conversation]")!.click());
  dblclick(q("[data-hub-conversation-draft]")!);
  await typeName(q("[data-hub-conversation-rename]") as HTMLInputElement, "Pages round 2");
  expect(q("[data-hub-conversation-draft]")!.textContent).toBe("Pages round 2");
  expect(q("[data-hub-conversation-title]")!.textContent).toBe("Pages round 2");
  expect(convs()).toHaveLength(1);
  await send("ok so for the pages lane i want blocks from github themed like the hub");
  expect(convs()).toHaveLength(2);
  expect(convs()[0]).toMatchObject({ title: "Pages round 2", named: true });
  chat.sendMessage(room.id, "and a preview before it applies", convs()[0].id);
  expect(chat.getChat(room.id)!.conversations[0].title).toBe("Pages round 2");
});

it("double-click renames a conversation; the name holds through later messages and a restart", async () => {
  const { q, first, room, show } = await render();
  dblclick(q(`[data-hub-conversation="${first}"]`)!);
  const input = q("[data-hub-conversation-rename]") as HTMLInputElement;
  expect(input.value).toBe("whats the plan for pages");
  await typeName(input, "Pages plan");
  expect(q(`[data-hub-conversation="${first}"]`)!.textContent).toContain("Pages plan");
  expect(q("[data-hub-conversation-title]")!.textContent).toBe("Pages plan");
  // The header's name renames as well.
  dblclick(q("[data-hub-conversation-title]")!);
  await typeName(q("[data-hub-conversation-rename]") as HTMLInputElement, "Pages plan (locked)");
  expect(q("[data-hub-conversation-title]")!.textContent).toBe("Pages plan (locked)");
  // Escape keeps the old name.
  dblclick(q(`[data-hub-conversation="${first}"]`)!);
  await act(async () => {
    const i = q("[data-hub-conversation-rename]") as HTMLInputElement;
    i.value = "oops";
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(q("[data-hub-conversation-title]")!.textContent).toBe("Pages plan (locked)");
  // A restart: the window is rebuilt from what was saved.
  act(() => root.unmount());
  root = createRoot(container);
  vi.resetModules();
  const chat = await import("../model/hubChats");
  expect(chat.getChat(room.id)!.conversations.find((c) => c.id === first)).toMatchObject({ title: "Pages plan (locked)", named: true });
  chat.sendMessage(room.id, "new topic: autopilot for the weekend", first);
  expect(chat.getChat(room.id)!.conversations.find((c) => c.id === first)!.title).toBe("Pages plan (locked)");
  void show;
});

it("a photo and a file go with the message: kept by path (a pasted photo saved to a file), shown, and handed to the Mono", async () => {
  const { q, convs, chat, room } = await render({ withConversation: false });
  const seen: { attachments?: unknown; prompt: string }[] = [];
  chat.setGroupChatRunner({
    run: async (request) => {
      seen.push({ attachments: request.attachments, prompt: request.prompt });
      return { kind: "reply", text: "Seen the screenshot and the notes." };
    },
  });
  act(() => q("[data-hub-new-conversation]")?.click());
  const pasted: Attachment = { id: "a1", name: "image.png", mimeType: "image/png", kind: "image", size: 68, data: "iVBORw0KGgo=" };
  const file: Attachment = { id: "a2", name: "combo-notes.md", mimeType: "text/markdown", kind: "file", size: 120, path: "/Users/ash/Desktop/combo-notes.md" };
  await send("", [pasted, file]);
  // An attachment-only message is taken (it used to be refused and the files lost).
  expect(convs()).toHaveLength(1);
  const message = convs()[0].messages[0];
  expect(convs()[0].title).toBe("image.png, combo-notes.md");
  expect(written).toEqual([{ name: "image.png", data: "iVBORw0KGgo=" }]);
  expect(message.attachments).toEqual([
    { id: "a1", name: "image.png", mimeType: "image/png", kind: "image", size: 68, path: "/tmp/monocode-attachments/1-2-image.png" },
    { id: "a2", name: "combo-notes.md", mimeType: "text/markdown", kind: "file", size: 120, path: "/Users/ash/Desktop/combo-notes.md" },
  ]);
  // Never the bytes in the store: only where the file is.
  expect(localStorage.getItem("monocode:hub-chats")).not.toContain("iVBORw0KGgo=");
  await act(async () => {
    await chat.roomIdle(room.id);
  });
  expect(seen[0].attachments).toEqual(message.attachments);
  expect(seen[0].prompt).toContain("combo-notes.md (\"/Users/ash/Desktop/combo-notes.md\")");
  expect([...container.querySelectorAll("[data-hub-msg-attachment]")].map((e) => e.getAttribute("data-hub-msg-attachment"))).toEqual(["image.png", "combo-notes.md"]);
  expect(container.textContent).toContain("Seen the screenshot and the notes.");
});

it("a file that can't be kept stops the send with the reason, and nothing is posted", async () => {
  const { convs } = await render();
  const lost: Attachment = { id: "x", name: "ghost.pdf", mimeType: "application/pdf", kind: "file", size: 1 };
  let error: unknown;
  await act(async () => {
    try {
      await composer.submit!("see this", [lost]);
    } catch (e) {
      error = e;
    }
  });
  expect(String(error)).toContain("Couldn't keep ghost.pdf");
  expect(convs()[0].messages).toHaveLength(1);
});
