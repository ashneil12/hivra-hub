// @vitest-environment happy-dom
// WP-125: a hivra link in chat markdown must reach the opener. A raw <a> is not enough.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AgentMarkdown } from "./AgentMarkdown";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

const CHAT = "11111111-1111-4111-8111-111111111111";
const CHAT_HREF = `hivra://local/chat/${CHAT}`;
const WEB_HREF = "https://example.com/notes";
const OPEN_EVENT = "hivra:open-thread-link";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(openUrl).mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

async function render(text: string) {
  await act(async () => {
    root.render(<AgentMarkdown text={text} />);
  });
}

function listen(): string[] {
  const seen: string[] = [];
  const onOpen = (event: Event) => {
    const url = (event as CustomEvent<unknown>).detail;
    if (typeof url === "string") seen.push(url);
  };
  window.addEventListener(OPEN_EVENT, onOpen);
  return seen;
}

it("a hivra link from the markdown renderer opens in the app and not as a web page", async () => {
  const seen = listen();
  await render(`[Open the chat](${CHAT_HREF})`);
  const link = container.querySelector("a");
  expect(link?.className).toContain("text-sky-400/90");
  expect(link?.getAttribute("href")?.toLowerCase().startsWith("hivra:")).toBe(true);
  await act(async () => {
    link?.click();
  });
  expect(seen.some((url) => url.toLowerCase().startsWith("hivra:"))).toBe(true);
  expect(seen.join("\n").toLowerCase()).not.toContain("https://");
  expect(openUrl).not.toHaveBeenCalled();
});

it("an https link from the markdown renderer still opens as a web page", async () => {
  const seen = listen();
  await render(`[A web page](${WEB_HREF})`);
  const link = container.querySelector("a");
  expect(link?.getAttribute("href")).toBe(WEB_HREF);
  await act(async () => {
    link?.click();
  });
  expect(openUrl).toHaveBeenCalledTimes(1);
  expect(openUrl).toHaveBeenCalledWith(WEB_HREF);
  expect(seen).toEqual([]);
});
