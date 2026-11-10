import { expect, it } from "vitest";
import { bespokeSrcdoc, newFrameNonce } from "./sandbox";

const spec = { html: "<p>x</p>", css: "", js: "" };

it("bakes the frame's nonce into the document once, and the helper removes its own script so the page can't read it", () => {
  const nonce = newFrameNonce();
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(newFrameNonce()).not.toBe(nonce);
  const doc = bespokeSrcdoc(spec, {}, "dark", nonce);
  expect(doc.split(nonce)).toHaveLength(2);
  expect(doc).toContain("document.currentScript.remove()");
  expect(doc).not.toContain("__NONCE__");
});

it("a nonce can't break out of its string", () => {
  expect(bespokeSrcdoc(spec, {}, "dark", `a"; alert(1); "`)).not.toContain("alert(1)");
});
