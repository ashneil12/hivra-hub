// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  reportThreadLink,
  resetThreadLinkStateForTests,
  threadLinkNotice,
} from "../model/threadLinkOpen";
import { THREAD_LINK_MESSAGE, chatLink } from "../model/threadLinks";
import { CopyThreadLinkButton, ThreadLinkNotice, useThreadLinkOpener } from "./ThreadLinkActions";

const CHAT = "11111111-1111-4111-8111-111111111111";
const writeText = vi.fn(async () => {});

let container: HTMLDivElement;
let root: Root;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetThreadLinkStateForTests();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  resetThreadLinkStateForTests();
});

it("copies the chat link and a late copy does not overwrite a newer one", async () => {
  const first = deferred<{ url: string }>();
  let calls = 0;
  const prepare = () => {
    calls += 1;
    if (calls === 1) return first.promise;
    return Promise.resolve({ url: "hivra://local/prompt/demo?text=second" });
  };
  await act(async () => {
    root.render(<CopyThreadLinkButton kind="prompt" label="Copy prompt link" prepare={prepare} />);
  });
  const button = container.querySelector("button");
  expect(button?.textContent).toBe("Copy prompt link");
  await act(async () => {
    button?.click();
    button?.click();
  });
  await act(async () => {
    first.resolve({ url: "hivra://local/prompt/demo?text=first" });
  });
  expect(button?.textContent).toBe("Copied");
  expect(button?.getAttribute("data-link")).toBe("hivra://local/prompt/demo?text=second");
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledWith("hivra://local/prompt/demo?text=second");
});

it("says when the link cannot be copied", async () => {
  writeText.mockRejectedValue(new Error("no clipboard"));
  await act(async () => {
    root.render(
      <CopyThreadLinkButton kind="chat" label="Copy chat link" url={chatLink(CHAT)} />,
    );
  });
  await act(async () => {
    container.querySelector("button")?.click();
  });
  expect(threadLinkNotice()?.message).toBe(THREAD_LINK_MESSAGE.copyFailed);
  expect(container.querySelector("button")?.textContent).toBe("Copy chat link");
});

it("shows the notice and closes it", async () => {
  await act(async () => {
    root.render(<ThreadLinkNotice />);
  });
  expect(container.querySelector("[data-thread-link-notice]")).toBeNull();
  await act(async () => {
    reportThreadLink(THREAD_LINK_MESSAGE.missingChat);
  });
  const notice = container.querySelector("[data-thread-link-notice]");
  expect(notice?.textContent).toContain("This chat is not on this computer.");
  expect(notice?.textContent).not.toMatch(/[—–]/);
  expect(notice?.textContent?.toLowerCase()).not.toContain("http");
  await act(async () => {
    container.querySelectorAll("button")[0]?.click();
  });
  expect(container.querySelector("[data-thread-link-notice]")).toBeNull();
});

function OpenerProbe({
  onOpen,
}: {
  onOpen: (id: string) => void;
}) {
  useThreadLinkOpener({
    hasChat: (id) => id === CHAT,
    hasProject: () => false,
    openChat: onOpen,
    openPrompt: () => {},
  });
  return (
    <>
      <h1>Demo chat</h1>
      <a href={`hivra://local/chat/${CHAT}`}>Open demo</a>
      <a href="https://example.com/chat">Web</a>
    </>
  );
}

it("a hivra link opens the chat and a web link is left alone", async () => {
  const opened: string[] = [];
  await act(async () => {
    root.render(<OpenerProbe onOpen={(id) => opened.push(id)} />);
  });
  const anchors = container.querySelectorAll("a");
  const web = anchors[1] as HTMLAnchorElement;
  const hivra = anchors[0] as HTMLAnchorElement;
  const webEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => {
    web.dispatchEvent(webEvent);
  });
  expect(webEvent.defaultPrevented).toBe(false);
  expect(opened).toEqual([]);
  await act(async () => {
    hivra.click();
  });
  expect(opened).toEqual([CHAT]);
  expect(container.textContent).toContain("Demo chat");
});
