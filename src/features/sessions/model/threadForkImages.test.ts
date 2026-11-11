import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import type { Session } from "./session";
import { forkChat } from "./threadFork";
import { copyGeneratedImage, forkImagePort } from "./threadForkImages";

const ORIGINAL = "/data/generated-images/one.png";
const COPY = { path: "/data/generated-images/new.png", mimeType: "image/png", size: 3 };

function commands(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invoke.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected command ${name}`);
    return handler(args);
  });
}

beforeEach(() => {
  invoke.mockReset();
});

describe("copyGeneratedImage", () => {
  it("has the app copy the original inside its generated-images folder", async () => {
    commands({ copy_generated_image: () => COPY });
    expect(await copyGeneratedImage(ORIGINAL, "cat.png")).toEqual(COPY);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("copy_generated_image", { path: ORIGINAL, name: "cat.png" });
  });

  it("never reads the original into the page, whatever path the block names", async () => {
    commands({ copy_generated_image: () => null });
    await copyGeneratedImage("/Users/someone/.ssh/id_rsa", "id_rsa");
    const asked = invoke.mock.calls.map(([name]) => name);
    expect(asked).toEqual(["copy_generated_image"]);
    expect(asked).not.toContain("read_file_base64");
    expect(asked).not.toContain("read_binary_file");
    expect(asked).not.toContain("save_generated_image");
  });

  it("gives null when the app has no such image to copy: gone, or not one of its own", async () => {
    commands({ copy_generated_image: () => null });
    expect(await copyGeneratedImage(ORIGINAL, "cat.png")).toBeNull();
  });

  it("asks the app on this Mac even for a path that names a connected machine", async () => {
    commands({ copy_generated_image: () => null });
    expect(await copyGeneratedImage("remote://machine/data/generated-images/one.png", "cat.png")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("fails, and does not call it gone, when the app could not copy the file", async () => {
    commands({
      copy_generated_image: () => {
        throw `${ORIGINAL}: Permission denied (os error 13)`;
      },
    });
    await expect(copyGeneratedImage(ORIGINAL, "cat.png")).rejects.toMatch(/Permission denied/);
  });
});

describe("forking a chat whose image block names a file outside the app's folder", () => {
  const OUTSIDE = "/Users/someone/.ssh/id_rsa.png";

  function chatWith(path: string): Session {
    return {
      id: "source",
      harness: "claude",
      model: "m",
      modelSettings: {},
      runtimeMode: "auto",
      title: "Chat",
      cwd: "/work/project",
      blocks: [
        { id: "a", role: "user", text: "draw" },
        {
          id: "b",
          role: "image",
          text: "",
          image: { path, name: "generated-image", mimeType: "image/png", size: 10 },
        },
        { id: "c", role: "assistant", text: "done" },
      ],
    } as Session;
  }

  function newIds() {
    let n = 0;
    return { next: () => `id${(n += 1)}` };
  }

  it("makes the fork without the picture, and reads and copies nothing", async () => {
    commands({ copy_generated_image: () => null });
    const fork = await forkChat(chatWith(OUTSIDE), "c", { useNewWorktree: false }, forkImagePort, newIds());
    expect(fork?.blocks.map((block) => block.role)).toEqual(["user", "image", "assistant"]);
    expect(fork?.blocks[1].image).toBeUndefined();
    expect(invoke.mock.calls).toEqual([["copy_generated_image", { path: OUTSIDE, name: "generated-image" }]]);
  });

  it("points the fork at the copy the app made of a real image", async () => {
    commands({ copy_generated_image: () => COPY });
    const source = chatWith(ORIGINAL);
    const fork = await forkChat(source, "c", { useNewWorktree: false }, forkImagePort, newIds());
    expect(fork?.blocks[1].image?.path).toBe(COPY.path);
    expect(source.blocks[1].image?.path).toBe(ORIGINAL);
  });
});

describe("forkImagePort.removeImages", () => {
  it("removes the named images and carries on when the app skipped a path outside its images folder", async () => {
    commands({ delete_generated_images: () => ({ removed: 1, skipped: 1 }) });
    await expect(forkImagePort.removeImages(["/data/generated-images/a.png", "/elsewhere/b.png"])).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("delete_generated_images", {
      paths: ["/data/generated-images/a.png", "/elsewhere/b.png"],
    });
  });
});
