// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRemoteCommandRunner } from "../../../platform/tauri/fs";
import { AgentMarkdown } from "./AgentMarkdown";

// A reply is untrusted text, so a path in it must never make the app read or
// stream a file on its own say-so. Rust decides, from the chat's id and the
// app's records, which folders a chat may show media from (its tests are in
// fs.rs and chat_media.rs); these render the real Markdown and watch every
// native call it makes: which command, and what it is told.

const core = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: core.invoke,
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CWD = "/work/repo";
const CHAT = "chat-1";
const REFUSED = "That file can't be shown in this chat.";

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
  // Rust: the two root-checked commands answer; anything else is a read the
  // chat must not make, so it fails loudly.
  core.invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
    if (command === "read_chat_image") return PNG.buffer.slice(0);
    if (command === "allow_video_stream") return args?.path;
    throw new Error(`Unexpected command: ${command}`);
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

async function render(
  text: string,
  options: { cwd?: string; mediaSessionId?: string } = { cwd: CWD, mediaSessionId: CHAT },
) {
  await act(async () => {
    root.render(createElement(AgentMarkdown, { text, localMedia: true, ...options }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const nativeCalls = () => core.invoke.mock.calls.map(([command]) => command);

describe("Markdown media on this computer is asked of Rust, by chat", () => {
  it("reads an image with the chat's id and no folders, so Rust picks them", async () => {
    await render(
      "![x](/work/repo/docs/shot.png)\n\n![y](</work/repo/a b.png>)\n\n![z](/work/repo-worktrees/feature/shot.png)",
    );

    expect(core.invoke.mock.calls).toEqual([
      ["read_chat_image", { path: "/work/repo/docs/shot.png", sessionId: CHAT }],
      ["read_chat_image", { path: "/work/repo/a b.png", sessionId: CHAT }],
      ["read_chat_image", { path: "/work/repo-worktrees/feature/shot.png", sessionId: CHAT }],
    ]);
    expect(container.querySelectorAll("img")).toHaveLength(3);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:chat-media");
  });

  it("asks about a generated image and a link to an image the same way", async () => {
    await render("![gen](/app/data/generated-images/one.png)\n\nSee [the shot](/work/repo/shot.png).");

    expect(core.invoke.mock.calls).toEqual([
      ["read_chat_image", { path: "/app/data/generated-images/one.png", sessionId: CHAT }],
      ["read_chat_image", { path: "/work/repo/shot.png", sessionId: CHAT }],
    ]);
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });

  it("streams a video only after Rust checks it against the chat's folders", async () => {
    await render("![clip](/work/repo/clips/demo.mp4)");

    expect(core.invoke.mock.calls).toEqual([
      ["allow_video_stream", { path: "/work/repo/clips/demo.mp4", sessionId: CHAT }],
    ]);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "asset://localhost/work/repo/clips/demo.mp4",
    );
  });

  it("never reads a file with the unchecked commands, whatever the path", async () => {
    await render(
      [
        "![a](/Users/me/.ssh/leak.png)",
        "![b](/work/repo-evil/leak.png)",
        "![c](/net/host/leak.png)",
        "![d](/Users/me/Movies/leak.mp4)",
        "[e](/Users/me/shot.png)",
      ].join("\n\n"),
    );

    expect(nativeCalls().every((command) => command === "read_chat_image" || command === "allow_video_stream")).toBe(
      true,
    );
    expect(nativeCalls()).not.toContain("read_binary_file");
    for (const [, args] of core.invoke.mock.calls) {
      expect(Object.keys(args as object).sort()).toEqual(["path", "sessionId"]);
    }
  });

  it("shows the path as a link where Rust refuses an image", async () => {
    core.invoke.mockRejectedValue(REFUSED);
    await render("![x](/Users/me/.ssh/leak.png)\n\nSee [the shot](/Users/me/shot.png).");

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-local-media]")).toBeNull();
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "/Users/me/.ssh/leak.png",
      "the shot",
    ]);
  });

  it("shows the path as a link where Rust refuses a video, and a link out of the folder", async () => {
    core.invoke.mockRejectedValue(REFUSED);
    await render("![clip](/Users/me/Movies/private.mp4)\n\n![x](/work/repo/docs/link-out.png)");

    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "/Users/me/Movies/private.mp4",
      "docs/link-out.png",
    ]);
  });

  it("asks for nothing when there is no chat to ask for", async () => {
    await render("![x](/work/repo/shot.png)\n\n![y](/Users/me/shot.png)", { cwd: CWD });

    expect(nativeCalls()).toEqual([]);
    expect(container.querySelector("img")).toBeNull();
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "shot.png",
      "/Users/me/shot.png",
    ]);
  });
});

describe("A refused image is asked for again when what Rust knows may have changed", () => {
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it("tries again for a new chat id, so a chat saved a moment later shows its image", async () => {
    core.invoke.mockRejectedValue(REFUSED);
    await render("![x](/work/repo/shot.png)", { cwd: CWD, mediaSessionId: "not-saved-yet" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")?.textContent).toBe("shot.png");

    core.invoke.mockReset();
    core.invoke.mockImplementation(async () => PNG.buffer.slice(0));
    await render("![x](/work/repo/shot.png)", { cwd: CWD, mediaSessionId: "saved" });

    expect(core.invoke.mock.calls).toEqual([
      ["read_chat_image", { path: "/work/repo/shot.png", sessionId: "saved" }],
    ]);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("tries again when the roster changes, so a Mono given a project shows its images", async () => {
    core.invoke.mockRejectedValue(REFUSED);
    await render("![x](/work/proj/shot.png)");
    expect(container.querySelector("img")).toBeNull();
    expect(nativeCalls()).toEqual(["read_chat_image"]);

    core.invoke.mockReset();
    core.invoke.mockImplementation(async () => PNG.buffer.slice(0));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("monocode:monos-changed"));
    });
    await settle();

    expect(core.invoke.mock.calls).toEqual([
      ["read_chat_image", { path: "/work/proj/shot.png", sessionId: CHAT }],
    ]);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("does not ask again on a roster change while an image shows", async () => {
    await render("![x](/work/repo/shot.png)");
    expect(nativeCalls()).toEqual(["read_chat_image"]);

    await act(async () => {
      window.dispatchEvent(new CustomEvent("monocode:monos-changed"));
    });
    await settle();

    expect(nativeCalls()).toEqual(["read_chat_image"]);
  });
});

describe("Markdown media in a chat on a connected machine", () => {
  const REMOTE = "remote://env-1/home/me/proj";
  const pngBase64 = () => btoa(String.fromCharCode(...PNG));

  it("reads an image in the project through the machine, which keeps reads inside its projects", async () => {
    const runner = vi.fn(async () => pngBase64());
    setRemoteCommandRunner(runner);
    await render("![x](/home/me/proj/shot.png)", { cwd: REMOTE });

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
      { cwd: REMOTE },
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
