// WP-130 review: in the app a srcdoc frame inherits the app's policy (script-src 'self'), so a visual reply's own
// script and the theme and height helper never ran, the same failure bespoke pages had (C3 live, 22 Oct). In the app
// the shell is now handed to the app and served from its frame scheme with the visual policy. Saving used an
// <a download> click, which the app's web view cancels (it has no download handler); in the app it now asks where
// to save and writes the file.
import { describe, expect, it, vi } from "vitest";
import { newFrameId, saveVisualReply, visualFrameDrop, visualFrameKey, visualFrameUrl } from "./visualFrame";

describe("where a visual reply's frame loads from", () => {
  it("in the app: the shell goes to the app with the network choice, and the frame loads it from the frame scheme", async () => {
    const put = vi.fn(async (key: string) => `page-${key}`);
    const url = await visualFrameUrl("visual-ab12-3", "<p>x</p>", true, {
      inApp: true,
      put,
      url: (p) => `monoartifact://localhost/${p}`,
    });
    expect(put).toHaveBeenCalledWith("visual-ab12-3", "<p>x</p>", true);
    expect(url).toBe("monoartifact://localhost/page-visual-ab12-3");
  });

  it("outside the app, or when the app refuses it, there is no served frame", async () => {
    expect(await visualFrameUrl("visual-a-0", "<p>x</p>", false, { inApp: false })).toBeUndefined();
    expect(
      await visualFrameUrl("visual-a-0", "<p>x</p>", false, {
        inApp: true,
        put: async () => {
          throw new Error("no");
        },
      }),
    ).toBeUndefined();
    expect(
      await visualFrameUrl("visual-a-0", "<p>x</p>", false, { inApp: true, put: async () => "page-other" }),
    ).toBeUndefined();
  });

  it("keys are plain, start with visual- and differ per frame and version", () => {
    const a = visualFrameKey("ab12cd34", 0);
    const b = visualFrameKey("ab12cd34", 1);
    expect(a).toMatch(/^visual-[A-Za-z0-9-]+$/);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
    expect(visualFrameKey("../x:y", 2)).toMatch(/^visual-[A-Za-z0-9-]+$/);
  });
});

describe("saving a visual reply", () => {
  it("in the app: asks where to save, then writes the original reply there", async () => {
    const ask = vi.fn(async () => "/tmp/chart.html");
    const write = vi.fn(async () => undefined);
    const download = vi.fn();
    expect(await saveVisualReply("<p>chart</p>", { inApp: true, ask, write, download })).toBe("saved");
    expect(ask).toHaveBeenCalledWith("visual-reply.html");
    expect(write).toHaveBeenCalledWith("/tmp/chart.html", "<p>chart</p>");
    expect(download).not.toHaveBeenCalled();
  });

  it("in the app: a closed dialog writes nothing, and a failed write says so", async () => {
    const write = vi.fn(async () => undefined);
    expect(await saveVisualReply("<p>x</p>", { inApp: true, ask: async () => null, write })).toBe("cancelled");
    expect(write).not.toHaveBeenCalled();
    expect(
      await saveVisualReply("<p>x</p>", {
        inApp: true,
        ask: async () => "/tmp/x.html",
        write: async () => {
          throw new Error("disk full");
        },
      }),
    ).toBe("failed");
  });

  it("outside the app: downloads the original reply as bytes that never render as a page", async () => {
    const download = vi.fn();
    expect(await saveVisualReply("<p>chart</p>", { inApp: false, download })).toBe("saved");
    const [blob, name] = download.mock.calls[0] as [Blob, string];
    expect(name).toBe("visual-reply.html");
    expect(blob.type).toBe("application/octet-stream");
    expect(await blob.text()).toBe("<p>chart</p>");
  });
});

// WP-130 review, items 4 and 5: a replaced or unmounted frame leaves the app's store, and a missing source of
// randomness gives no frame at all rather than a predictable id.
describe("dropping a served frame and naming it", () => {
  it("in the app a replaced or unmounted frame is dropped from the store", async () => {
    const drop = vi.fn(async () => undefined);
    await visualFrameDrop("visual-ab-1", { inApp: true, drop });
    expect(drop).toHaveBeenCalledWith("visual-ab-1");
  });

  it("outside the app nothing is dropped, and a refused drop is not an error", async () => {
    const drop = vi.fn(async () => undefined);
    await visualFrameDrop("visual-ab-1", { inApp: false, drop });
    expect(drop).not.toHaveBeenCalled();
    await expect(
      visualFrameDrop("visual-ab-1", {
        inApp: true,
        drop: async () => {
          throw new Error("gone");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed without randomness: no id, so no frame", () => {
    expect(newFrameId(undefined)).toBeNull();
    expect(newFrameId({} as Crypto)).toBeNull();
    const id = newFrameId({
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    } as unknown as Crypto);
    expect(id).toBe("070707070707");
    expect(newFrameId(globalThis.crypto)).toMatch(/^[0-9a-f]{12}$/);
  });
});
