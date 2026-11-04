// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../monos/ui/MonoComposer", () => ({
  MonoComposer: (props: { onSubmit?: (text: string, files: { id: string }[]) => unknown }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-test-council-send": "1",
        onClick: () => void props.onSubmit?.("/council should we ship", [{ id: "pic" }]),
      },
      "Send",
    ),
}));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens a council from /council even when a file is attached, and keeps the room's members", async () => {
  const nav = await import("../model/hubNav");
  const chats = await import("../model/hubChats");
  const { GroupChatView } = await import("./GroupChatView");
  nav.setHubSelection({ project: "hub", item: "coding-team" });
  const room = chats.createChat("hub", "Pricing", ["chief-of-staff", "frank"]);
  chats.startConversation(room.id, "What now?");
  const before = chats.getChat(room.id)!.conversations[0].messages.length;
  await act(async () => {
    root.render(createElement(GroupChatView, { chatId: room.id, projectId: "hub" }));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>("[data-test-council-send]")!.click();
  });
  const opened = chats.listChats("hub").find((chat) => chat.id !== room.id && chat.council?.question === "should we ship");
  expect(opened?.memberIds).toEqual(["chief-of-staff", "frank"]);
  expect(chats.getChat(room.id)!.conversations[0].messages.length).toBe(before);
});
