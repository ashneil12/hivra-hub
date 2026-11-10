// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatFolderBanner } from "./ChatFolderBanner";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(cwd: string, pick: () => Promise<string | undefined>, onChoose = vi.fn()) {
  act(() => {
    root.render(createElement(ChatFolderBanner, { session: { cwd }, onChoose, pick }));
  });
  return onChoose;
}

it("says a chat with no folder needs one, and offers the folder picker", async () => {
  const pick = vi.fn(async () => "/work/proj");
  const onChoose = show("", pick);
  expect(host.querySelector("[data-chat-needs-folder]")?.textContent).toContain(
    "Choose a project folder for this chat first.",
  );
  await act(async () => {
    host.querySelector("button")!.click();
  });
  expect(pick).toHaveBeenCalledOnce();
  expect(onChoose).toHaveBeenCalledWith("/work/proj");
});

it("leaves the chat as it is when the picker is cancelled", async () => {
  const onChoose = show("  ", async () => undefined);
  await act(async () => {
    host.querySelector("button")!.click();
  });
  expect(onChoose).not.toHaveBeenCalled();
});

it("shows nothing for a chat that has a folder, the home folder included", () => {
  show("/work/proj", async () => undefined);
  expect(host.querySelector("[data-chat-needs-folder]")).toBeNull();
  show("~", async () => undefined);
  expect(host.querySelector("[data-chat-needs-folder]")).toBeNull();
});
