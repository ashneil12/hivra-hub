// C3 live 22 Oct: a connected page was blank in the real app because its srcdoc frame inherited the app's
// script-src 'self'. In the app the page now loads from the frame scheme with its own policy.
import { describe, expect, it, vi } from "vitest";
import { frameKey, pageFrameUrl } from "./pageFrame";

describe("where a bespoke page's frame loads from", () => {
  it("in the app: the document goes to the app and the frame loads it from the frame scheme", async () => {
    const put = vi.fn(async (key: string) => `page-${key}`);
    const url = await pageFrameUrl("pg_1-abc-0-dark", "<p>x</p>", { inApp: true, put, url: (p) => `monoartifact://localhost/${p}` });
    expect(put).toHaveBeenCalledWith("pg_1-abc-0-dark", "<p>x</p>");
    expect(url).toBe("monoartifact://localhost/page-pg_1-abc-0-dark");
  });

  it("outside the app, or when the app refuses it, the frame keeps its srcdoc", async () => {
    expect(await pageFrameUrl("k", "<p>x</p>", { inApp: false })).toBeUndefined();
    expect(await pageFrameUrl("k", "<p>x</p>", { inApp: true, put: async () => { throw new Error("no"); } })).toBeUndefined();
  });

  it("keys are short, plain and differ per page, version, frame and theme", () => {
    const k = frameKey("pg_10226a6b58", "1x9z", 0, "dark");
    expect(k).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    expect(new Set([k, frameKey("pg_2", "1x9z", 0, "dark"), frameKey("pg_10226a6b58", "2", 0, "dark"), frameKey("pg_10226a6b58", "1x9z", 1, "dark"), frameKey("pg_10226a6b58", "1x9z", 0, "light")]).size).toBe(5);
    expect(frameKey("../../etc", "", 0, "").length).toBeLessThanOrEqual(64);
  });
});
