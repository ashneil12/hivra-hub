// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRemoteCommandRunner } from "../../../platform/tauri/fs";
import { AgentMarkdown } from "./AgentMarkdown";

// A reply is untrusted text, so a path in it must never make the app read or
// stream a file the chat has no business showing. These render the real
// Markdown and watch every native call it makes.

const core = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: core.invoke,
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CWD = "/work/repo";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Everything is "near view" at once, as a short chat is.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chat-media");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  core.invoke.mockReset();
  core.invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
    if (command === "allow_video_stream") return args?.path;
    // Any read hands back a PNG, so a read that should not happen is visible
    // as a call, not hidden by a failure.
    return PNG.buffer.slice(0);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(text: string, cwd: string | undefined = CWD) {
  await act(async () => {
    root.render(createElement(AgentMarkdown, { text, cwd, localMedia: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const nativeCalls = () => core.invoke.mock.calls.map(([command]) => command);

describe("Markdown media outside the chat's folders", () => {
  it.each([
    ["a file elsewhere on the computer", "/Users/me/.ssh/leak.png", "/Users/me/.ssh/leak.png"],
    [
      "in a sibling folder that shares the project's name as a prefix",
      "/work/repo-evil/leak.png",
      "/work/repo-evil/leak.png",
    ],
    // The Markdown sanitizer already turns this into /leak.png.
    ["a path that climbs out of the project", "../leak.png", "/leak.png"],
    [
      "a path that climbs out and back through the project's own name",
      "/work/repo/../repo-evil/leak.png",
      "/work/repo-evil/leak.png",
    ],
  ])("never reads an image that is %s, and shows its path as a link", async (_name, path, shown) => {
    await render(`![x](${path})`);

    expect(nativeCalls()).toEqual([]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-local-media]")).toBeNull();
    expect(container.querySelector("a")?.textContent).toBe(shown);
  });

  it("never reads or streams a video outside the chat's folders", async () => {
    await render("![clip](/Users/me/Movies/private.mp4)\n\n![clip](/work/repo-evil/private.mov)");

    expect(nativeCalls()).toEqual([]);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("[data-local-media]")).toBeNull();
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "/Users/me/Movies/private.mp4",
      "/work/repo-evil/private.mov",
    ]);
  });

  it("leaves a link to an outside image as the plain link it is", async () => {
    await render("See [the shot](/Users/me/shot.png).");

    expect(nativeCalls()).toEqual([]);
    expect(container.querySelector("[data-local-media]")).toBeNull();
    expect(container.querySelector("a")?.textContent).toBe("the shot");
  });

  it("asks for nothing when the chat has no folder", async () => {
    await render("![x](/Users/me/shot.png)", undefined);

    expect(nativeCalls()).toEqual([]);
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows an image Rust refuses, such as a link out of the folder, as its path", async () => {
    // A symlink inside the project that points out looks inside to the
    // webview; Rust follows it and refuses.
    core.invoke.mockRejectedValue("That file can't be shown in this chat.");
    await render("![x](/work/repo/docs/link-out.png)");

    expect(nativeCalls()).toEqual(["read_chat_image"]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")?.textContent).toBe("docs/link-out.png");
  });
});

describe("Markdown media inside the chat's folders", () => {
  it("reads an image in the chat's folder through the root-checked command", async () => {
    await render("![x](/work/repo/docs/shot.png)\n\n![y](</work/repo/a b.png>)");

    expect(core.invoke.mock.calls).toEqual([
      ["read_chat_image", { path: "/work/repo/docs/shot.png", roots: [CWD] }],
      ["read_chat_image", { path: "/work/repo/a b.png", roots: [CWD] }],
    ]);
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:chat-media");
  });

  it("reads a generated image from the app's generated-images folder", async () => {
    await render("![gen](/app/data/generated-images/one.png)");

    expect(core.invoke.mock.calls).toEqual([
      ["read_chat_image", { path: "/app/data/generated-images/one.png", roots: [CWD] }],
    ]);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:chat-media");
  });

  it("streams a video in the chat's folder after Rust checks it against the folder", async () => {
    await render("![clip](/work/repo/clips/demo.mp4)");

    expect(core.invoke.mock.calls).toEqual([
      ["allow_video_stream", { path: "/work/repo/clips/demo.mp4", roots: [CWD] }],
    ]);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "asset://localhost/work/repo/clips/demo.mp4",
    );
  });

  it("shows a link to an image in the chat's folder in place", async () => {
    await render("See [the shot](/work/repo/shot.png).");

    expect(core.invoke.mock.calls).toEqual([
      ["read_chat_image", { path: "/work/repo/shot.png", roots: [CWD] }],
    ]);
    expect(container.querySelector("img")).not.toBeNull();
  });
});

describe("Markdown media in a chat on a connected machine", () => {
  const REMOTE = "remote://env-1/home/me/proj";
  const pngBase64 = () => btoa(String.fromCharCode(...PNG));

  it("reads an image in the project through the machine, which keeps reads inside its projects", async () => {
    const runner = vi.fn(async () => pngBase64());
    setRemoteCommandRunner(runner);
    await render("![x](/home/me/proj/shot.png)", REMOTE);

    expect(runner).toHaveBeenCalledWith("read_binary_file", { path: `${REMOTE}/shot.png` });
    expect(nativeCalls()).toEqual([]);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("asks the machine for nothing outside the project", async () => {
    const runner = vi.fn(async () => pngBase64());
    setRemoteCommandRunner(runner);
    await render(
      [
        "![x](/home/me/proj-evil/shot.png)",
        "![y](/home/me/other/shot.png)",
        "[z](remote://env-2/home/me/proj/shot.png)",
        `[w](${REMOTE}/../shot.png)`,
      ].join("\n\n"),
      REMOTE,
    );

    expect(runner).not.toHaveBeenCalled();
    expect(nativeCalls()).toEqual([]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-local-media]")).toBeNull();
  });
});

describe("Markdown media from other places, unchanged", () => {
  it("makes no native call for a data image", async () => {
    await render(`![dot](data:image/png;base64,iVBORw0KGgo=)`);

    expect(nativeCalls()).toEqual([]);
  });

  it("does not load a remote image", async () => {
    await render("![x](https://example.com/a.png)");

    expect(nativeCalls()).toEqual([]);
    expect(container.querySelector("img")).toBeNull();
  });
});
