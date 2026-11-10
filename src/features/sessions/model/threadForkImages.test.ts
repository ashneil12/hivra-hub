import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { copyGeneratedImage, forkImagePort } from "./threadForkImages";

const ORIGINAL = "/data/generated-images/one.png";

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
  it("saves the original's bytes as a new generated image", async () => {
    commands({
      read_file_base64: () => "AAAA",
      save_generated_image: () => ({ path: "/data/generated-images/new.png", mimeType: "image/png", size: 3 }),
    });
    expect(await copyGeneratedImage(ORIGINAL, "cat.png")).toEqual({
      path: "/data/generated-images/new.png",
      mimeType: "image/png",
      size: 3,
    });
    expect(invoke).toHaveBeenCalledWith("read_file_base64", { path: ORIGINAL });
    expect(invoke).toHaveBeenCalledWith("save_generated_image", { data: "AAAA", name: "cat.png" });
  });

  it("gives null, and saves nothing, when the original is no longer on disk", async () => {
    commands({
      read_file_base64: () => {
        throw `${ORIGINAL}: No such file or directory (os error 2)`;
      },
      stat_files: (args) => (args.paths as string[]).map((path) => ({ path, mtimeMs: null })),
    });
    expect(await copyGeneratedImage(ORIGINAL, "cat.png")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("save_generated_image", expect.anything());
  });

  it("fails, and does not call it gone, when the file is there but could not be read", async () => {
    commands({
      read_file_base64: () => {
        throw `${ORIGINAL}: Permission denied (os error 13)`;
      },
      stat_files: (args) => (args.paths as string[]).map((path) => ({ path, mtimeMs: 1 })),
    });
    await expect(copyGeneratedImage(ORIGINAL, "cat.png")).rejects.toMatch(/Permission denied/);
  });

  it("fails when it cannot tell whether the file is there", async () => {
    commands({
      read_file_base64: () => {
        throw "Too many open files";
      },
      stat_files: () => {
        throw new Error("ipc down");
      },
    });
    await expect(copyGeneratedImage(ORIGINAL, "cat.png")).rejects.toBe("Too many open files");
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
