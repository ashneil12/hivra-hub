import { describe, expect, it } from "vitest";
import type { Attachment } from "../../../../features/sessions/model/session";
import { t3AttachmentParts } from "./t3Attachments";

const picture: Attachment = { id: "a1", name: "Example shot.jpg", mimeType: "image/jpg", kind: "image", size: 70, data: "AAAA" };
const notes: Attachment = { id: "a2", name: "notes.pdf", mimeType: "application/pdf", kind: "file", size: 900, path: "/example/notes.pdf" };

describe("a turn's attachments as T3 takes them", () => {
  it("uploads a picture a model can look at and names every other attachment by its path", () => {
    const folder: Attachment = { id: "a3", name: "docs", mimeType: "inode/directory", kind: "file", size: 0, path: "/example/docs" };
    expect(t3AttachmentParts("Example: compare these.", [picture, notes, folder])).toEqual({
      text: [
        "Example: compare these.",
        'Attached file (read from disk): "/example/notes.pdf"',
        'Attached folder (list or read the files inside from this path): "/example/docs"',
      ].join("\n\n"),
      uploads: [
        { type: "image", name: "Example shot.jpg", mimeType: "image/jpeg", sizeBytes: 70, dataUrl: "data:image/jpeg;base64,AAAA" },
      ],
    });
  });

  it("sends a picture the engine would refuse as a path, and says so when there is no path to give", () => {
    const large: Attachment = { ...picture, size: 11 * 1024 * 1024, path: "/example/large.jpg" };
    const svg: Attachment = { id: "a4", name: "logo.svg", mimeType: "image/svg+xml", kind: "image", size: 40, data: "AAAA", path: "/example/logo.svg" };
    const parts = t3AttachmentParts("Example: look", [large, svg]);
    expect(parts.uploads).toEqual([]);
    expect(parts.text).toContain('"/example/large.jpg"');
    expect(parts.text).toContain('"/example/logo.svg"');
    expect(() => t3AttachmentParts("Example: look", [{ ...notes, path: undefined }])).toThrow(/no local file path/);
  });

  it("leaves a turn with nothing attached as it is, and gives a turn that is only attachments its usual words", () => {
    expect(t3AttachmentParts("Example: hello", [])).toEqual({ text: "Example: hello", uploads: [] });
    expect(t3AttachmentParts("", [picture]).text.length).toBeGreaterThan(0);
  });
});
