// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment, GeneratedImageMeta } from "../model/session";
import * as fs from "../../../platform/tauri/fs";
import { GeneratedImage } from "./GeneratedImage";

vi.mock("../../../platform/tauri/fs", () => ({
  readBinaryFile: vi.fn(),
  readGeneratedImage: vi.fn(),
}));
vi.mock("../../../platform/tauri/trackpadZoom", () => ({
  claimTrackpadMagnify: () => () => {},
}));
import { AttachmentChip } from "./AttachmentChip";

const attachment: Attachment = {
  id: "image-1",
  name: "diagram.png",
  mimeType: "image/png",
  kind: "image",
  size: 42,
  previewUrl: "blob:image-preview",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(fs.readBinaryFile).mockReset();
  vi.mocked(fs.readGeneratedImage).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(onRemove?: () => void) {
  act(() =>
    root.render(createElement(AttachmentChip, { attachment, onRemove })),
  );
}

describe("AttachmentChip image preview", () => {
  it("opens the image full screen and closes it with Escape", () => {
    render();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open diagram.png full screen"]',
    )!;

    act(() => trigger.focus());
    act(() => trigger.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe(
      "Image preview: diagram.png",
    );
    expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(
      attachment.previewUrl,
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close image preview",
    );

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("loads persisted generated images and opens a lightbox", async () => {
    const image: GeneratedImageMeta = {
      path: "/app-data/generated-images/image.png",
      name: "generated-image",
      mimeType: "image/png",
      size: 8,
      alt: "A clean product photo",
    };
    vi.mocked(fs.readGeneratedImage).mockResolvedValue(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:generated-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    await act(async () => {
      root.render(createElement(GeneratedImage, { image }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const preview = container.querySelector<HTMLImageElement>("img");
    expect(preview?.getAttribute("src")).toBe("blob:generated-image");
    expect(preview?.getAttribute("alt")).toBe("A clean product photo");

    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open generated-image full screen"]',
    )!;
    act(() => trigger.click());
    expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe(
      "blob:generated-image",
    );
  });

  async function renderGenerated(image: GeneratedImageMeta) {
    await act(async () => {
      root.render(createElement(GeneratedImage, { image }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  const GENERATED: GeneratedImageMeta = {
    path: "/app-data/generated-images/image.png",
    name: "generated-image",
    mimeType: "image/png",
    size: 8,
  };

  it("reads a generated image only through the app's own image command", async () => {
    vi.mocked(fs.readGeneratedImage).mockResolvedValue(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:generated-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await renderGenerated(GENERATED);
    expect(fs.readGeneratedImage).toHaveBeenCalledWith(GENERATED.path);
    expect(fs.readBinaryFile).not.toHaveBeenCalled();
  });

  it("shows a picture whose file is not here as missing, not as an error", async () => {
    vi.mocked(fs.readGeneratedImage).mockResolvedValue(null);
    await renderGenerated({ ...GENERATED, path: "/Users/someone/.ssh/id_rsa.png" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("not on this Mac");
    expect(container.textContent).not.toContain("Could not open");
  });

  it("does not look for a file when the chat names none", async () => {
    await renderGenerated({ ...GENERATED, path: "" });
    expect(fs.readGeneratedImage).not.toHaveBeenCalled();
    expect(fs.readBinaryFile).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("not on this Mac");
  });

  it("says it could not open the picture when the read fails or the file is not an image", async () => {
    vi.mocked(fs.readGeneratedImage).mockRejectedValueOnce(new Error("disk"));
    await renderGenerated(GENERATED);
    expect(container.textContent).toContain("Could not open generated image");
    vi.mocked(fs.readGeneratedImage).mockResolvedValueOnce(new TextEncoder().encode("<html>"));
    await renderGenerated({ ...GENERATED, path: "/app-data/generated-images/other.png" });
    expect(container.textContent).toContain("Could not open generated image");
  });

  it("says a saved attachment with no file kept is not available, and still names it", () => {
    // What an imported chat's attachment looks like: its name and kind, never the path on the other Mac.
    const file: Attachment = { id: "f", name: "id_rsa", mimeType: "application/octet-stream", kind: "file", size: 3 };
    act(() => root.render(createElement(AttachmentChip, { attachment: file })));
    expect(container.textContent).toContain("id_rsa");
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe("id_rsa (file not available)");
  });

  it("shows the path of an attachment that has one", () => {
    const file: Attachment = { id: "f", name: "notes.md", mimeType: "text/markdown", kind: "file", size: 3, path: "/work/notes.md" };
    act(() => root.render(createElement(AttachmentChip, { attachment: file })));
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe("/work/notes.md");
  });

  it("removes an image without opening the preview", () => {
    const onRemove = vi.fn();
    render(onRemove);

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove diagram.png"]')!
        .click(),
    );

    expect(onRemove).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
