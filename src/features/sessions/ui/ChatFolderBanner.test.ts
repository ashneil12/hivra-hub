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

async function show(cwd: string, pick: () => Promise<string | undefined>, onChoose = vi.fn(), offer: (id: string) => Promise<string | null> = async () => null) {
  await act(async () => {
    root.render(createElement(ChatFolderBanner, { session: { id: "s1", cwd }, onChoose, pick, offer }));
  });
  return onChoose;
}

it("says a chat with no folder needs one, and offers the folder picker", async () => {
  const pick = vi.fn(async () => "/work/proj");
  const onChoose = await show("", pick);
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
  const onChoose = await show("  ", async () => undefined);
  await act(async () => {
    host.querySelector("button")!.click();
  });
  expect(onChoose).not.toHaveBeenCalled();
});

it("shows nothing for a chat that has a folder, the home folder included", async () => {
  await show("/work/proj", async () => undefined);
  expect(host.querySelector("[data-chat-needs-folder]")).toBeNull();
  await show("~", async () => undefined);
  expect(host.querySelector("[data-chat-needs-folder]")).toBeNull();
});

it("offers the folder its file named once Rust says it passes, and never before", async () => {
  const none = await show("", async () => undefined, vi.fn(), async () => null);
  expect(host.querySelector("[data-chat-relink]")).toBeNull();
  expect(none).not.toHaveBeenCalled();
  const offer = vi.fn(async () => "/work/proj/later");
  const onChoose = await show("", async () => undefined, vi.fn(), offer);
  expect(offer).toHaveBeenCalledWith("s1");
  const button = host.querySelector("[data-chat-relink]") as HTMLButtonElement;
  expect(button.textContent).toBe("Use /work/proj/later");
  await act(async () => {
    button.click();
  });
  expect(onChoose).toHaveBeenCalledWith("/work/proj/later");
  // A chat that has a folder asks nothing.
  const quiet = vi.fn(async () => "/x");
  await show("/work/proj", async () => undefined, vi.fn(), quiet);
  expect(quiet).not.toHaveBeenCalled();
});
